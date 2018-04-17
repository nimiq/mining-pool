const Nimiq = require('../core/dist/node.js');

class PoolAgent extends Nimiq.Observable {
    constructor(pool, ws) {
        super();

        /** @type {PoolServer} */
        this._pool = pool;

        /** @type {WebSocket} */
        this._ws = ws;
        this._ws.onmessage = (msg) => this._onMessageData(msg.data);
        this._ws.onerror = () => this._onError();
        this._ws.onclose = () => this._onClose();

        /** @type {number} */
        this._difficulty = this._pool.config.minDifficulty;

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

    async sendBalance() {
        this._send({
            message: PoolAgent.MESSAGE_BALANCE,
            balance: Math.floor(await this._pool.getUserBalance(this._userId, true)),
            confirmedBalance: Math.floor(await this._pool.getUserBalance(this._userId)),
            payoutRequestActive: await this._pool.hasPayoutRequest(this._userId)
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
            Nimiq.Log.e(PoolAgent, e);
            this._pool.ban(this._ws);
        }
    }

    /**
     * @param {Object} msg
     * @private
     */
    async _onMessage(msg) {
        Nimiq.Log.v(PoolAgent, () => `IN: ${JSON.stringify(msg)}`);
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
                if (this._sharesSinceReset > 3 && 1000 * this._sharesSinceReset / Math.abs(Date.now() - this._lastReset) > this._pool.config.desiredSps * 2) {
                    this._recalcDifficulty();
                }
                break;
            }
            case PoolAgent.MESSAGE_PAYOUT: {
                await this._onPayoutMessage(msg);
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
        switch (msg.mode) {
            case PoolAgent.MODE_SMART:
                this.mode = PoolAgent.MODE_SMART;
                break;
            case PoolAgent.MODE_NANO:
                this.mode = PoolAgent.MODE_NANO;
                break;
            default:
                throw new Error('Client did not specify mode');
        }

        const genesisHash = Nimiq.Hash.unserialize(Nimiq.BufferUtils.fromBase64(msg.genesisHash));
        if (!genesisHash.equals(Nimiq.GenesisConfig.GENESIS_HASH)) {
            this._send({
                message: PoolAgent.MESSAGE_ERROR,
                reason: 'different genesis block'
            });
            throw new Error('Client has different genesis block');
        }

        this._sharesSinceReset = 0;
        this._lastReset = Date.now();
        this._timeout = setTimeout(() => this._recalcDifficulty(), this._pool.config.spsTimeUnit);
        this._userId = await this._pool.getStoreUserId(this._address);
        this._regenerateNonce();
        this._regenerateExtraData();

        this._registered = true;
        this._send({
            message: PoolAgent.MESSAGE_REGISTERED
        });

        this._sendSettings();
        if (this.mode === PoolAgent.MODE_NANO) {
            this._pool.requestCurrentHead(this);
        }
        await this.sendBalance();
        this._sendBalanceInterval = setInterval(() => this.sendBalance(), 1000 * 60 * 2);

        Nimiq.Log.i(PoolAgent, `REGISTER ${this._address.toUserFriendlyAddress()}, current balance: ${await this._pool.getUserBalance(this._userId)}`);
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
                message: PoolAgent.MESSAGE_ERROR,
                reason: 'invalid share ' + invalidReason
            });
            return;
        }

        const prevBlock = await this._pool.consensus.blockchain.getBlock(block.prevHash);
        const nextTarget = await this._pool.consensus.blockchain.getNextTarget(prevBlock);
        if (Nimiq.BlockUtils.isProofOfWork(await block.header.pow(), nextTarget)) {
            this._pool.consensus.blockchain.pushBlock(block);
            this.fire('block', block.header);
        }

        await this._pool.storeShare(this._userId, this._deviceId, block.header.prevHash, block.header.height - 1, this._difficulty, hash);

        Nimiq.Log.d(PoolAgent, () => `SHARE from ${this._address.toUserFriendlyAddress()}, prev ${block.header.prevHash} : ${hash}`);

        this.fire('share', block.header, this._difficulty);
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

        if (!(await block.isImmediateSuccessorOf(this._prevBlock))) {
            return 'bad prev';
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
        const fullBlock = msg.block ? Nimiq.Block.unserialize(Nimiq.BufferUtils.fromBase64(msg.block)) : null;

        const invalidReason = await this._isSmartShareValid(header, hash, minerAddrProof, extraDataProof, fullBlock);
        if (invalidReason !== null) {
            this._send({
                message: PoolAgent.MESSAGE_ERROR,
                reason: 'invalid share ' + invalidReason
            });
            throw new Error('Client sent invalid share');
        }

        // If we know a successor of the block mined onto, it does not make sense to mine onto that block anymore
        const prevBlock = await this._pool.consensus.blockchain.getBlock(header.prevHash);
        if (prevBlock !== null) {
            const successors = await this._pool.consensus.blockchain.getSuccessorBlocks(prevBlock, true);
            if (successors.length > 0) {
                this._send({
                    message: PoolAgent.MESSAGE_ERROR,
                    reason: 'too old'
                });
                return;
            }
        }

        const nextTarget = await this._pool.consensus.blockchain.getNextTarget(prevBlock);
        if (Nimiq.BlockUtils.isProofOfWork(await header.pow(), nextTarget)) {
            if (fullBlock && (await this._pool.consensus.blockchain.pushBlock(fullBlock)) === Nimiq.FullChain.ERR_INVALID) {
                this._send({
                    message: PoolAgent.MESSAGE_ERROR,
                    reason: 'invalid block'
                });
                throw new Error('Client sent invalid block');
            }

            this.fire('block', header);
        }

        await this._pool.storeShare(this._userId, this._deviceId, header.prevHash, header.height - 1, this._difficulty, hash);

        Nimiq.Log.d(PoolAgent, () => `SHARE from ${this._address.toUserFriendlyAddress()}, prev ${header.prevHash} : ${hash}`);

        this.fire('share', header, this._difficulty);
    }

    /**
     * @param {Nimiq.BodyHeader} header
     * @param {Nimiq.Hash} hash
     * @param {Nimiq.MerklePath} minerAddrProof
     * @param {Nimiq.MerklePath} extraDataProof
     * @param {Nimiq.Block} fullBlock
     * @returns {Promise.<?string>}
     * @private
     */
    async _isSmartShareValid(header, hash, minerAddrProof, extraDataProof, fullBlock) {
        // Check if the share was already submitted
        if (await this._pool.containsShare(this._userId, hash)) {
            return 'already sent';
        }

        // Check if we are the _miner or the share
        if (!(await minerAddrProof.computeRoot(this._pool.poolAddress)).equals(header.bodyHash)) {
            return 'miner address mismatch';
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

        // Check if the full block matches the header.
        if (fullBlock && !hash.equals(fullBlock.hash())) {
            return 'invalid block';
        }

        return null;
    }

    /**
     * @param {Object} msg
     * @private
     */
    async _onPayoutMessage(msg) {
        await this._pool.storePayoutRequest(this._userId);
    }

    /**
     * @param {Nimiq.SerialBuffer} msgProof
     * @param {string} prefix
     * @returns {Promise.<boolean>}
     * @private
     */
    async _verifyProof(msgProof, prefix) {
        const proof = Nimiq.SignatureProof.unserialize(msgProof);
        const buf = new Nimiq.SerialBuffer(8 + prefix.length);
        buf.writeString(prefix, prefix.length);
        buf.writeUint64(this._nonce);
        return await proof.verify(this._address, buf);
    }

    /**
     * To reduce network traffic, we set the minimum share difficulty for a user according to their number of shares in the last SPS_TIME_UNIT
     */
    _recalcDifficulty() {
        clearTimeout(this._timeout);
        const sharesPerMinute = 1000 * this._sharesSinceReset / Math.abs(Date.now() - this._lastReset);
        if (sharesPerMinute / this._pool.config.desiredSps > 2) {
            this._difficulty *= 1.5;
            this._regenerateExtraData();
            this._sendSettings();
        } else if (sharesPerMinute === 0 || this._pool.config.desiredSps / sharesPerMinute > 2) {
            this._difficulty = Math.max(this._pool.config.minDifficulty, this._difficulty / 1.5);
            this._regenerateExtraData();
            this._sendSettings();
        }
        this._sharesSinceReset = 0;
        this._lastReset = Date.now();
        this._timeout = setTimeout(() => this._recalcDifficulty(), this._pool.config.spsTimeUnit);
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
        Nimiq.Log.v(PoolAgent, () => `OUT: ${JSON.stringify(msg)}`);
        try {
            this._ws.send(JSON.stringify(msg));
        } catch (e) {
            Nimiq.Log.e(PoolAgent, e);
            this._onError();
        }
    }

    _onClose() {
        this._offAll();

        clearInterval(this._sendBalanceInterval);
        clearTimeout(this._timeout);
        this._pool.removeAgent(this);
    }

    _onError() {
        this._pool.removeAgent(this);
        this._ws.close();
    }
}
PoolAgent.MESSAGE_REGISTER = 'register';
PoolAgent.MESSAGE_REGISTERED = 'registered';
PoolAgent.MESSAGE_PAYOUT = 'payout';
PoolAgent.MESSAGE_SHARE = 'share';
PoolAgent.MESSAGE_SETTINGS = 'settings';
PoolAgent.MESSAGE_BALANCE = 'balance';
PoolAgent.MESSAGE_NEW_BLOCK = 'new-block';
PoolAgent.MESSAGE_ERROR = 'error';

PoolAgent.MODE_NANO = 'nano';
PoolAgent.MODE_SMART = 'smart';

PoolAgent.PAYOUT_NONCE_PREFIX = 'POOL_PAYOUT';
PoolAgent.TRANSFER_NONCE_PREFIX = 'POOL_TRANSFER_FUNDS';

module.exports = exports = PoolAgent;
