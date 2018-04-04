const Nimiq = require('../core/dist/node.js');
const PoolConfig = require('./PoolConfig.js');

class PoolAgent {
    constructor(pool, ws) {
        /** @type {PoolServer} */
        this._pool = pool;

        /** @type {WebSocket} */
        this._ws = ws;
        this._ws.onmessage = (msg) => this._onMessageData(msg.data);
        this._ws.onerror = () => this._onError();
        this._ws.onclose = () => this._onClose();

        /** @type {number} */
        this._difficulty = PoolConfig.START_DIFFICULTY;

        /** @type {number} */
        this._sharesSinceReset = 0;

        /** @type {number} */
        this._lastReset = 0;

        /** @type {boolean} */
        this._registered = false;
    }

    /**
     * @param {Nimiq.Block} prevBlock
     * @param {Array.<Nimiq.Transaction>} transactions
     * @param {Array.<Nimiq.PrunedAccount>} prunedAccounts
     * @param {Nimiq.Hash} accountsHash
     */
    async updateBlock(prevBlock, transactions, prunedAccounts, accountsHash) {
        if (this.mode !== PoolAgent.MODE_NANO) return;
        if (!prevBlock || !transactions || !prunedAccounts || !accountsHash) return;

        this._currentBody = new Nimiq.BlockBody(this._pool.poolAddress, transactions, this._extraData, prunedAccounts);
        const bodyHash = await this._currentBody.hash();
        this._accountsHash = accountsHash;
        this._prevBlock = prevBlock;

        this._send({
            message: PoolAgent.MESSAGE_NEW_BLOCK,
            bodyHash: Nimiq.BufferUtils.toBase64(bodyHash.serialize()),
            accountsHash: Nimiq.BufferUtils.toBase64(accountsHash.serialize()),
            previousBlock: Nimiq.BufferUtils.toBase64(prevBlock.serialize())
        });
    }

    /**
     * @param {string} data
     * @private
     */
    async _onMessageData(data) {
        try {
            await this._onMessage(JSON.parse(data));
        } catch (e) {
            console.log(e);
            this._pool.ban(this._ws);
        }
    }

    /**
     * @param {Object} msg
     * @private
     */
    async _onMessage(msg) {
        console.log('IN');
        console.log(msg);
        if (msg.message === PoolAgent.MESSAGE_REGISTER) {
            await this._onRegisterMessage(msg);
            return;
        }

        if (!this._registered) {
            this._send({
                message: 'registration-required'
            });
            throw new Error('Client did not register');
        }

        switch (msg.message) {
            case PoolAgent.MESSAGE_SHARE: {
                if (this.mode === PoolAgent.MODE_NANO) {
                    await this._onNanoShareMessage(msg);
                } else if (this.mode === PoolAgent.MODE_SMART) {
                    await this._onSmartShareMessage(msg);
                }
                this._sharesSinceReset++;
                if (this._sharesSinceReset > 3 && 1000 * this._sharesSinceReset / Math.abs(Date.now() - this._lastReset) > PoolConfig.DESIRED_SPS * 2) {
                    this._recalcDifficulty();
                }
                break;
            }
            case PoolAgent.MESSAGE_PAYOUT: {
                await this._onPayoutMessage(msg);
                break;
            }
            case PoolAgent.MESSAGE_BALANCE_REQUEST: {
                await this._onBalanceRequest(msg);
                break;
            }
        }
    }

    /**
     * @param {Object} msg
     * @private
     */
    async _onRegisterMessage(msg) {
        this._address = Nimiq.Address.fromUserFriendlyAddress(msg.address);
        this._deviceId = msg.deviceId;
        if (msg.mode === 'smart') {
            this.mode = PoolAgent.MODE_SMART;
        } else if (msg.mode === 'nano'){
            this.mode = PoolAgent.MODE_NANO;
        } else {
            throw new Error('Client did not specify mode');
        }

        this._sharesSinceReset = 0;
        this._lastReset = Date.now();
        this._timeout = setTimeout(() => this._recalcDifficulty(), PoolConfig.SPS_TIME_UNIT);
        this._userId = await this._pool.getStoreUserId(this._address);
        this._regenerateNonce();
        this._regenerateExtraData();

        this._registered = true;

        this._sendSettings();
        if (this.mode === 'nano') {
            this._pool.requestCurrentHead(this);
        }
        console.log("REGISTER " + this._address.toUserFriendlyAddress() + " current balance: " + await this._pool.getUserBalance(this._userId));
    }

    /**
     * @param {Object} msg
     * @private
     */
    async _onNanoShareMessage(msg) {
        const lightBlock = Nimiq.Block.unserialize(Nimiq.BufferUtils.fromBase64(msg.block));
        const block = lightBlock.toFull(this._currentBody);
        const hash = block.hash();

        // Check if the share was already submitted
        if (await this._pool.containsShare(this._userId, hash)) {
            throw new Error('Client submitted share twice');
        }

        const invalidReason = await this._isNanoShareValid(block, hash);
        if (invalidReason !== null) {
            this._send({
                message: PoolAgent.MESSAGE_INVALID_SHARE,
                reason: invalidReason
            });
            return;
        }

        const nextTarget = await this._pool.consensus.blockchain.getNextTarget(await this._pool.consensus.blockchain.getBlock(block.prevHash));
        if (Nimiq.BlockUtils.isProofOfWork(await block.header.pow(), nextTarget)) {
            this._pool.consensus.blockchain.pushBlock(block);
        }
        await this._pool.storeShare(this._userId, this._deviceId, block.header.prevHash, block.header.height - 1, this._difficulty, hash);
        console.log('SHARE from ' + this._address.toUserFriendlyAddress() + ' prev ' + block.header.prevHash + ' : ' + hash);
    }

    /**
     * @param {Nimiq.Block} block
     * @param {Nimiq.Hash} hash
     * @returns {Promise.<?string>}
     * @private
     */
    async _isNanoShareValid(block, hash) {
        // Check if the body hash is the one we've sent
        if (!block.header.bodyHash.equals(this._currentBody.hash())) {
            return 'wrong body hash';
        }

        // Check if the account hash is the one we've sent
        if (!block.header._accountsHash.equals(this._accountsHash)) {
            return 'wrong accounts hash';
        }

        // Check if the share fulfills the difficulty set for this client
        const pow = await block.header.pow();
        if (!Nimiq.BlockUtils.isProofOfWork(pow, Nimiq.BlockUtils.difficultyToTarget(this._difficulty))) {
            return 'invalid pow';
        }

        // Check that the timestamp is not too far into the future.
        if (block.header.timestamp * 1000 > this._pool.consensus.network.time + Nimiq.Block.TIMESTAMP_DRIFT_MAX * 1000) {
            return 'bad timestamp';
        }

        // Verify that the interlink is valid.
        if (!block._verifyInterlink()) {
            return 'bad interlink';
        }

        if (!block.isImmediateSuccessorOf(this._prevBlock)) {
            return 'bad prev'
        }
        return null;
    }

    /**
     * @param {Object} msg
     * @private
     */
    async _onSmartShareMessage(msg) {
        const header = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(msg.blockHeader));
        const hash = await header.hash();
        const minerAddrProof = Nimiq.MerklePath.unserialize(Nimiq.BufferUtils.fromBase64(msg.minerAddrProof));
        const extraDataProof = Nimiq.MerklePath.unserialize(Nimiq.BufferUtils.fromBase64(msg.extraDataProof));

        const invalidReason = await this._isSmartShareValid(header, hash, minerAddrProof, extraDataProof);
        if (invalidReason !== null) {
            this._send({
                message: PoolAgent.MESSAGE_INVALID_SHARE,
                reason: invalidReason
            });
            throw new Error('Client sent invalid share');
        }

        // If we know a successor of the block mined onto, it does not make sense to mine onto that block anymore
        const block = await this._pool.consensus.blockchain.getBlock(header.prevHash);
        if (block !== null) {
            const successors = await this._pool.consensus.blockchain.getSuccessorBlocks(block, true);
            if (successors.length > 0) {
                this._send({
                    message: PoolAgent.MESSAGE_INVALID_SHARE,
                    reason: 'too old'
                });
                return;
            }
        }

        await this._pool.storeShare(this._userId, this._deviceId, header.prevHash, header.height - 1, this._difficulty, hash);
        console.log('SHARE from ' + this._address.toUserFriendlyAddress() + ' prev ' + header.prevHash + ' : ' + hash);
    }

    /**
     * @param {Nimiq.BodyHeader} header
     * @param {Nimiq.Hash} hash
     * @param {Nimiq.MerklePath} minerAddrProof
     * @param {Nimiq.MerklePath} extraDataProof
     * @returns {Promise.<?string>}
     * @private
     */
    async _isSmartShareValid(header, hash, minerAddrProof, extraDataProof) {
        // Check if the share was already submitted
        if (await this._pool.containsShare(this._userId, hash)) {
            return 'already sent';
        }

        // Check if we are the _miner or the share
        if (!(await minerAddrProof.computeRoot(this._pool.poolAddress)).equals(header.bodyHash)) {
            return '_miner address mismatch';
        }

        // Check if the extra data is in the share
        if (!(await extraDataProof.computeRoot(this._extraData)).equals(header.bodyHash)) {
            return 'extra data mismatch';
        }

        // Check that the timestamp is not too far into the future.
        if (header.timestamp * 1000 > this._pool.consensus.network.time + Nimiq.Block.TIMESTAMP_DRIFT_MAX * 1000) {
            return 'bad timestamp';
        }

        // Check if the share fulfills the difficulty set for this client
        const pow = await header.pow();
        if (!Nimiq.BlockUtils.isProofOfWork(pow, Nimiq.BlockUtils.difficultyToTarget(this._difficulty))) {
            return 'invalid pow';
        }
        return null;
    }

    /**
     * @param {Object} msg
     * @private
     */
    async _onPayoutMessage(msg) {
        const proofValid = await this._verifyProof(Nimiq.BufferUtils.fromBase64(msg.proof), PoolAgent.PAYOUT_NONCE_PREFIX);
        if (proofValid) {
            await this._pool.storePayoutRequest(this._userId);
            this._regenerateNonce();
            this._sendSettings();
        } else {
            throw new Error('Client provided invalid proof for payout request');
        }
    }

    /**
     * @param {Object} msg
     * @private
     */
    async _onBalanceRequest(msg) {
        this._send({
            message: PoolAgent.MESSAGE_BALANCE_RESPONSE,
            balance: await this._pool.getUserBalance(this._userId),
            virtualBalance: await this._pool.getUserBalance(this._userId, true)
        });
    }

    /**
     * @param {Nimiq.SerialBuffer} msgProof
     * @param {string} prefix
     * @returns {Promise.<boolean>}
     * @private
     */
    async _verifyProof(msgProof, prefix) {
        console.log(msgProof);
        console.log(prefix);
        const proof = Nimiq.SignatureProof.unserialize(msgProof);
        const buf = new Nimiq.SerialBuffer(8 + prefix.length);
        buf.writeString(prefix, prefix.length);
        buf.writeUint64(this._nonce);
        return await proof.verify(this._address, buf);
    }

    _recalcDifficulty() {
        clearTimeout(this._timeout);
        const sharesPerMinute = 1000 * this._sharesSinceReset / Math.abs(Date.now() - this._lastReset);
        if (sharesPerMinute / PoolConfig.DESIRED_SPS > 2) {
            this._difficulty *= 1.5;
            this._regenerateExtraData();
            this._sendSettings();
        } else if (sharesPerMinute === 0 || PoolConfig.DESIRED_SPS / sharesPerMinute > 2) {
            this._difficulty = Math.max(PoolConfig.START_DIFFICULTY, this._difficulty / 1.5);
            this._regenerateExtraData();
            this._sendSettings();
        }
        this._sharesSinceReset = 0;
        this._lastReset = Date.now();
        this._timeout = setTimeout(() => this._recalcDifficulty(), PoolConfig.SPS_TIME_UNIT);
    }

    _sendSettings() {
        const settingsMessage = {
            message: PoolAgent.MESSAGE_SETTINGS,
            address: this._pool.poolAddress.toUserFriendlyAddress(),
            extraData: Nimiq.BufferUtils.toBase64(this._extraData),
            target: Nimiq.BlockUtils.difficultyToTarget(this._difficulty),
            nonce: this._nonce
        };
        this._send(settingsMessage);
    }

    _regenerateNonce() {
        /** @type {number} */
        this._nonce = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    }

    _regenerateExtraData() {
        this._extraData = new Nimiq.SerialBuffer(this._pool.name.length + this._address.serializedSize + 9);
        this._extraData.write(Nimiq.BufferUtils.fromAscii(this._pool.name));
        this._extraData.writeUint8(0);
        this._address.serialize(this._extraData);
        this._extraData.writeUint32(this._deviceId);
        this._extraData.writeUint32(Nimiq.BlockUtils.difficultyToCompact(this._difficulty));
    }

    /**
     * @param {Object} msg
     * @private
     */
    _send(msg) {
        console.log('OUT');
        console.log(msg);
        try {
            this._ws.send(JSON.stringify(msg));
        } catch (e) {
            console.log('error', e);
            this._onError();
        }
    }

    _onClose() {
        clearTimeout(this._timeout);
        this._pool.removeAgent(this);
    }

    _onError() {
        this._pool.removeAgent(this);
        this._ws.close();
    }
}
PoolAgent.MESSAGE_INVALID_SHARE = 'invalid-share';
PoolAgent.MESSAGE_REGISTER = 'register';
PoolAgent.MESSAGE_PAYOUT = 'payout';
PoolAgent.MESSAGE_SHARE = 'share';
PoolAgent.MESSAGE_SETTINGS = 'settings';
PoolAgent.MESSAGE_BALANCE_REQUEST = 'balance-request';
PoolAgent.MESSAGE_BALANCE_RESPONSE = 'balance-response';
PoolAgent.MESSAGE_NEW_BLOCK = 'new-block';

PoolAgent.MODE_NANO = 'nano';
PoolAgent.MODE_SMART = 'smart';

PoolAgent.PAYOUT_NONCE_PREFIX = 'POOL_PAYOUT';
PoolAgent.TRANSFER_NONCE_PREFIX = 'POOL_TRANSFER_FUNDS';

module.exports = exports = PoolAgent;
