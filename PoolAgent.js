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

        this._registered = false;
    }

    async _onMessageData(data) {
        try {
            await this._onMessage(JSON.parse(data));
        } catch (e) {
            this._pool.ban(this._ws);
        }
    }

    async _onMessage(msg) {
        if (msg.message === PoolAgent.MESSAGE_REGISTER) {
            await this._onRegisterMessage(msg);
            return;
        }

        if (!this._registered) {
            this._send({
                message: 'registration-required'
            });
            this._pool.ban(this._ws);
            return;
        }

        switch (msg.message) {
            case PoolAgent.MESSAGE_SHARE: {
                await this._onShareMessage(msg);
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

    async _onRegisterMessage(msg) {
        this._address = Nimiq.Address.fromUserFriendlyAddress(msg.address);
        this._deviceId = msg.deviceId;
        if (msg.mode === 'smart') {
            this._mode = PoolAgent.MODE_SMART;
        } else {
            this._mode = PoolAgent.MODE_DUMB;
        }

        this._sharesSinceReset = 0;
        this._lastReset = Date.now();
        this._timeout = setTimeout(() => this._recalcDifficulty(), PoolConfig.SPS_TIME_UNIT);
        this._userId = await this._pool.getStoreUserId(this._address);
        this._regenerateNonce();
        this._regenerateExtraData();

        this._registered = true;

        this._sendSettings();
        console.log("REGISTER " + this._address.toUserFriendlyAddress() + " current balance: " + await this._pool.getUserBalance(this._userId));
    }

    async _onShareMessage(msg) {
        const header = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(msg.blockHeader));
        const hash = await header.hash();
        const minerAddrProof = Nimiq.MerklePath.unserialize(Nimiq.BufferUtils.fromBase64(msg.minerAddrProof));
        const extraDataProof = Nimiq.MerklePath.unserialize(Nimiq.BufferUtils.fromBase64(msg.extraDataProof));

        const invalidReason = await this._isShareValid(header, hash, minerAddrProof, extraDataProof);
        if (invalidReason !== null) {
            this._send({
                message: PoolAgent.MESSAGE_INVALID_SHARE,
                reason: invalidReason
            });
            this._pool.ban(this._ws);
            return;
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

        this._sharesSinceReset++;
        await this._pool.storeShare(this._userId, header.prevHash, header.height, this._difficulty, hash);
        if (this._sharesSinceReset > 3 && 1000 * this._sharesSinceReset / Math.abs(Date.now() - this._lastReset) > PoolConfig.DESIRED_SPS * 2) {
            this._recalcDifficulty();
        }
        console.log('SHARE from ' + this._address.toUserFriendlyAddress() + ' prev ' + header.prevHash + ' : ' + hash);
    }

    async _isShareValid(header, hash, minerAddrProof, extraDataProof) {

        // Check if the share was already submitted
        if (await this._pool.containsShare(this._userId, hash)) {
            return 'already sent';
        }

        // Check if we are the miner or the share
        if (!(await minerAddrProof.computeRoot(this._pool.poolAddress)).equals(header.bodyHash)) {
            return 'miner address mismatch';
        }

        // Check if the extra data is in the share
        if (!(await extraDataProof.computeRoot(this._extraData)).equals(header.bodyHash)) {
            return 'extra data mismatch';
        }

        // Check if the share fulfills the difficulty set for this client
        const pow = await header.pow();
        if (!Nimiq.BlockUtils.isProofOfWork(pow, Nimiq.BlockUtils.difficultyToTarget(this._difficulty))) {
            return 'invalid pow';
        }
        return null;
    }

    async _onPayoutMessage(msg) {
        const proofValid = await this._verifyProof(msg.proof, PoolAgent.PAYOUT_NONCE_PREFIX);
        if (proofValid) {
            await this._pool.storePayoutRequest(this._userId);
            this._regenerateNonce();
            this._sendSettings();
        } else {
            this._pool.ban(this._ws);
        }
    }

    async _onTransferMessage(msg) {
        const proofValid = await this._verifyProof(msg.proof, PoolAgent.TRANSFER_NONCE_PREFIX);
        if (proofValid) {
            // well...
        } else {
            this._pool.ban(this._ws);
        }
    }

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
     * @returns {Promise<boolean>}
     * @private
     */
    async _verifyProof(msgProof, prefix) {
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
        this._extraData.writeUint32(this._nonce);
        this._extraData.writeUint32(Nimiq.BlockUtils.difficultyToCompact(this._difficulty));
    }

    _send(msg) {
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

    /** @type {number} */
    get nonce() {
        return this._nonce;
    }
}
PoolAgent.MESSAGE_INVALID_SHARE = 'invalid-share';
PoolAgent.MESSAGE_REGISTER = 'register';
PoolAgent.MESSAGE_PAYOUT = 'payout';
PoolAgent.MESSAGE_SHARE = 'share';
PoolAgent.MESSAGE_SETTINGS = 'settings';
PoolAgent.MESSAGE_BALANCE_REQUEST = 'balance-request';
PoolAgent.MESSAGE_BALANCE_RESPONSE = 'balance-response';

PoolAgent.MODE_DUMB = 'dumb';
PoolAgent.MODE_SMART = 'smart';

PoolAgent.PAYOUT_NONCE_PREFIX = 'POOL_PAYOUT';
PoolAgent.TRANSFER_NONCE_PREFIX = 'POOL_TRANSFER_FUNDS';

module.exports = exports = PoolAgent;
