const Nimiq = require('@nimiq/core');

class PoolAgent extends Nimiq.Observable {
    constructor(pool, ws, netAddress) {
        super();

        /** @type {PoolServer} */
        this._pool = pool;

        /** @type {WebSocket} */
        this._ws = ws;
        this._ws.onmessage = (msg) => this._onMessageData(msg.data);
        this._ws.onerror = () => this._onError();
        this._ws.onclose = () => this._onClose();

        /** @type {Nimiq.NetAddress} */
        this._netAddress = netAddress;

        /** @type {PoolAgent.Mode} */
        this.mode = PoolAgent.Mode.UNREGISTERED;

        /** @type {Uint8Array} */
        this._extraData = null;
        /** @type {number} */
        this._difficulty = this._pool.config.startDifficulty;

        // Store old extra data + difficulty to allow smart clients to be one settings change off.
        /** @type {Uint8Array} */
        this._extraDataOld = null;
        /** @type {number} */
        this._difficultyOld = this._difficulty;

        /** @type {number} */
        this._sharesSinceReset = 0;

        /** @type {number} */
        this._lastSpsReset = 0;

        /** @type {number} */
        this._errorsSinceReset = 0;

        /** @type {boolean} */
        this._registered = false;

        /** @type {Nimiq.Timers} */
        this._timers = new Nimiq.Timers();
        this._timers.resetTimeout('connection-timeout', () => this._onError(), this._pool.config.connectionTimeout);
    }

    /**
     * @param {Nimiq.Block} prevBlock
     * @param {Array.<Nimiq.Transaction>} transactions
     * @param {Array.<Nimiq.PrunedAccount>} prunedAccounts
     * @param {Nimiq.Hash} accountsHash
     */
    async updateBlock(prevBlock, transactions, prunedAccounts, accountsHash) {
        if (this.mode !== PoolAgent.Mode.NANO) return;
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
        this._errorsSinceReset = 0;
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
            this._pool.banIp(this._netAddress);
            this._ws.close();
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
            this._sendError('registration required');
            throw new Error('Client did not register');
        }

        switch (msg.message) {
            case PoolAgent.MESSAGE_SHARE: {
                if (this.mode === PoolAgent.Mode.NANO) {
                    await this._onNanoShareMessage(msg);
                } else if (this.mode === PoolAgent.Mode.SMART) {
                    await this._onSmartShareMessage(msg);
                }
                this._sharesSinceReset++;
                if (this._sharesSinceReset > 3 && 1000 * this._sharesSinceReset / Math.abs(Date.now() - this._lastSpsReset) > this._pool.config.desiredSps * 2) {
                    this._recalcDifficulty();
                }
                this._timers.resetTimeout('connection-timeout', () => this._onError(), this._pool.config.connectionTimeout);
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
        if (this._registered) {
            this._sendError('already registered');
            return;
        }

        this._address = Nimiq.Address.fromUserFriendlyAddress(msg.address);
        this._deviceId = msg.deviceId;
        switch (msg.mode) {
            case PoolAgent.MODE_SMART:
                this.mode = PoolAgent.Mode.SMART;
                break;
            case PoolAgent.MODE_NANO:
                this.mode = PoolAgent.Mode.NANO;
                break;
            default:
                throw new Error('Client did not specify mode');
        }

        const genesisHash = Nimiq.Hash.unserialize(Nimiq.BufferUtils.fromBase64(msg.genesisHash));
        if (!genesisHash.equals(Nimiq.GenesisConfig.GENESIS_HASH)) {
            this._sendError('different genesis block');
            throw new Error('Client has different genesis block');
        }

        this._sharesSinceReset = 0;
        this._lastSpsReset = Date.now();
        this._timers.resetTimeout('recalc-difficulty', () => this._recalcDifficulty(), this._pool.config.spsTimeUnit);
        this._userId = await this._pool.getStoreUserId(this._address);
        this._regenerateNonce();
        this._regenerateSettings();

        this._registered = true;
        this._send({
            message: PoolAgent.MESSAGE_REGISTERED
        });

        this._sendSettings();
        if (this.mode === PoolAgent.Mode.NANO) {
            this._pool.requestCurrentHead(this);
        }
        await this.sendBalance();
        this._timers.resetInterval('send-balance', () => this.sendBalance(), 1000 * 60 * 5);
        this._timers.resetInterval('send-keep-alive-ping', () => this._ws.ping(), 1000 * 10);

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

        const invalidReason = await this._isNanoShareValid(block, hash);
        if (invalidReason) {
            Nimiq.Log.d(PoolAgent, `INVALID share from ${this._address.toUserFriendlyAddress()} (nano): ${invalidReason}`);
            this._sendError('invalid share: ' + invalidReason);
            this._countNewError();
            return;
        }

        const prevBlock = await this._pool.consensus.blockchain.getBlock(block.prevHash);
        const nextTarget = await this._pool.consensus.blockchain.getNextTarget(prevBlock);
        if (Nimiq.BlockUtils.isProofOfWork(await block.header.pow(), nextTarget)) {
            this._pool.consensus.blockchain.pushBlock(block);
            this.fire('block', block.header);
        }

        try {
            await this._pool.storeShare(this._userId, this._deviceId, block.header.prevHash, block.header.height - 1, this._difficulty, hash);
        } catch (e) {
            this._sendError('submitted share twice');
            throw new Error('Client submitted share twice ' + e.message || e);
        }

        Nimiq.Log.v(PoolAgent, () => `SHARE from ${this._address.toUserFriendlyAddress()} (nano), prev ${block.header.prevHash} : ${hash}`);

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

        const {invalidReason, difficulty} = await this._isSmartShareValid(header, hash, minerAddrProof, extraDataProof, fullBlock);
        if (invalidReason) {
            Nimiq.Log.d(PoolAgent, `INVALID share from ${this._address.toUserFriendlyAddress()} (smart): ${invalidReason}`);
            this._sendError('invalid share: ' + invalidReason);
            this._countNewError();
            return;
        }

        // If we know a successor of the block mined onto, it does not make sense to mine onto that block anymore
        const prevBlock = await this._pool.consensus.blockchain.getBlock(header.prevHash);
        if (prevBlock !== null) {
            const successors = await this._pool.consensus.blockchain.getSuccessorBlocks(prevBlock, true);
            if (successors.length > 0) {
                this._sendError('share expired');
                return;
            }
        }

        const nextTarget = await this._pool.consensus.blockchain.getNextTarget(prevBlock);
        if (Nimiq.BlockUtils.isProofOfWork(await header.pow(), nextTarget)) {
            if (fullBlock && (await this._pool.consensus.blockchain.pushBlock(fullBlock)) === Nimiq.FullChain.ERR_INVALID) {
                this._sendError('invalid block');
                throw new Error('Client sent invalid block');
            }

            this.fire('block', header);
        }

        try {
            await this._pool.storeShare(this._userId, this._deviceId, header.prevHash, header.height - 1, difficulty, hash);
        } catch (e) {
            this._sendError('submitted share twice');
            throw new Error('Client submitted share twice ' + e.message || e);
        }

        Nimiq.Log.v(PoolAgent, () => `SHARE from ${this._address.toUserFriendlyAddress()} (smart), prev ${header.prevHash} : ${hash}`);

        this.fire('share', header, difficulty);
    }

    /**
     * @param {Nimiq.BodyHeader} header
     * @param {Nimiq.Hash} hash
     * @param {Nimiq.MerklePath} minerAddrProof
     * @param {Nimiq.MerklePath} extraDataProof
     * @param {Nimiq.Block} fullBlock
     * @returns {Promise.<{invalidReason: string}|{difficulty: number}>}
     * @private
     */
    async _isSmartShareValid(header, hash, minerAddrProof, extraDataProof, fullBlock) {
        // Check if we are the _miner or the share
        if (!(await minerAddrProof.computeRoot(this._pool.poolAddress)).equals(header.bodyHash)) {
            return {invalidReason: 'miner address mismatch'};
        }

        // Check if the extra data is in the share
        let expectedDifficulty;
        if (this._extraData && (await extraDataProof.computeRoot(this._extraData)).equals(header.bodyHash)) {
            expectedDifficulty = this._difficulty;
        } else if (this._extraDataOld && (await extraDataProof.computeRoot(this._extraDataOld)).equals(header.bodyHash)) {
            expectedDifficulty = this._difficultyOld;
        } else {
            return {invalidReason: 'extra data mismatch'};
        }

        // Check that the timestamp is not too far into the future.
        if (header.timestamp * 1000 > this._pool.consensus.network.time + Nimiq.Block.TIMESTAMP_DRIFT_MAX * 1000) {
            return {invalidReason: 'bad timestamp'};
        }

        // Check if the share fulfills the difficulty set for this client
        const pow = await header.pow();
        if (!Nimiq.BlockUtils.isProofOfWork(pow, Nimiq.BlockUtils.difficultyToTarget(expectedDifficulty))) {
            return {invalidReason: 'invalid pow'};
        }

        // Check if the full block matches the header.
        if (fullBlock && !hash.equals(fullBlock.hash())) {
            throw new Error('full block announced but mismatches');
        }

        return {difficulty: expectedDifficulty};
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
        this._timers.clearTimeout('recalc-difficulty');
        const sharesPerSecond = 1000 * this._sharesSinceReset / Math.abs(Date.now() - this._lastSpsReset);
        Nimiq.Log.d(PoolAgent, `SPS for ${this._address.toUserFriendlyAddress()}: ${sharesPerSecond.toFixed(2)} at difficulty ${this._difficulty}`);
        if (sharesPerSecond / this._pool.config.desiredSps > 2) {
            const newDifficulty = Math.round(this._difficulty * 1.2 * 1000) / 1000;
            this._regenerateSettings(newDifficulty);
            this._sendSettings();
        } else if (sharesPerSecond === 0 || this._pool.config.desiredSps / sharesPerSecond > 2) {
            const newDifficulty = Math.max(this._pool.config.minDifficulty, Math.round(this._difficulty / 1.2 * 1000) / 1000);
            this._regenerateSettings(newDifficulty);
            this._sendSettings();
        }
        this._sharesSinceReset = 0;
        this._lastSpsReset = Date.now();
        this._timers.resetTimeout('recalc-difficulty', () => this._recalcDifficulty(), this._pool.config.spsTimeUnit);
    }

    _countNewError() {
        this._errorsSinceReset++;
        if (this._errorsSinceReset > this._pool.config.allowedErrors) {
            throw new Error('Too many errors');
        }
    }

    _sendError(errorString) {
        this._send({
            message: PoolAgent.MESSAGE_ERROR,
            reason: errorString
        });
    }

    _sendSettings() {
        const settingsMessage = {
            message: PoolAgent.MESSAGE_SETTINGS,
            address: this._pool.poolAddress.toUserFriendlyAddress(),
            extraData: Nimiq.BufferUtils.toBase64(this._extraData),
            target: Nimiq.BlockUtils.difficultyToTarget(this._difficulty),
            targetCompact: Nimiq.BlockUtils.difficultyToCompact(this._difficulty),
            nonce: this._nonce
        };
        this._send(settingsMessage);
        this._errorsSinceReset = 0;
    }

    _regenerateNonce() {
        /** @type {number} */
        this._nonce = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    }

    _regenerateSettings(newDifficulty = this._difficulty) {
        this._difficultyOld = this._difficulty;
        this._extraDataOld = this._extraData;

        this._difficulty = newDifficulty;
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

        this._timers.clearAll();
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

/** @enum {number} */
PoolAgent.Mode = {
    UNREGISTERED: 0,
    NANO: 1,
    SMART: 2
};

PoolAgent.PAYOUT_NONCE_PREFIX = 'POOL_PAYOUT';

module.exports = exports = PoolAgent;
