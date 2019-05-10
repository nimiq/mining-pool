const Nimiq = require('@nimiq/core');
const mysql = require('mysql2/promise');

const Helper = require('./Helper.js');

class PoolPayout extends Nimiq.Observable {
    /**
     * @param {BaseConsensus} consensus
     * @param {Wallet} wallet
     * @param {PoolConfig} config
     * @param {string} mySqlPsw
     * @param {string} mySqlHost
     */
    constructor(consensus, wallet, config, mySqlPsw, mySqlHost) {
        super();
        /** @type {BaseConsensus} */
        this._consensus = consensus;

        /** @type {Wallet} */
        this._wallet = wallet;

        /** @type {PoolConfig} */
        this._config = config;

        /** @type {string} */
        this._mySqlPsw = mySqlPsw;

        /** @type {string} */
        this._mySqlHost = mySqlHost;

        /** @type {Timers} */
        this._timers = new Nimiq.Timers();
    }

    async start() {
        this.connectionPool = await mysql.createPool({
            host: this._mySqlHost,
            user: 'pool_payout',
            password: this._mySqlPsw,
            database: 'pool'
        });
        this.consensus.on('established', async () => {
            await this._processPayouts();
            this._timers.resetTimeout('wait-for-relayed', this._quit.bind(this), 30000);
            this.consensus.on('transaction-relayed', (tx) => {
                if (tx.sender.equals(this.wallet.address)) {
                    this._timers.resetTimeout('wait-for-relayed', this._quit.bind(this), 10000);
                }
            });
        });
        Nimiq.Log.i(PoolPayout, `Starting payout process using address ${this.wallet.address.toUserFriendlyAddress()}`);
    }

    _quit() {
        Nimiq.Log.i(PoolPayout, 'Finished, exiting now.');
        process.exit(0);
    }

    async _processPayouts() {
        const payinsValid = await this._validatePayins();
        if (!payinsValid) {
            throw new Error('Payin inconsistency');
        }

        const autoPayouts = await this._getAutoPayouts();
        Nimiq.Log.i(PoolPayout, `Processing ${autoPayouts.length} auto payouts`);
        for (const payout of autoPayouts) {
            await this._payout(payout.userId, payout.userAddress, payout.amount, false);
        }

        const payoutRequests = await this._getPayoutRequests();
        Nimiq.Log.i(PoolPayout, `Processing ${payoutRequests.length} payout requests`);
        for (const payoutRequest of payoutRequests) {
            const balance = await Helper.getUserBalance(this._config, this.connectionPool, payoutRequest.userId, this.consensus.blockchain.height);
            await this._payout(payoutRequest.userId, payoutRequest.userAddress, balance, true);
            await this._removePayoutRequest(payoutRequest.userId);
        }

        if (autoPayouts.length == 0 && payoutRequests.length == 0) {
            this._quit();
        }
    }

    /**
     * @param {number} recipientId
     * @param {Nimiq.Address} recipientAddress
     * @param {number} amount
     * @param {boolean} deductFees
     * @private
     */
    async _payout(recipientId, recipientAddress, amount, deductFees) {
        const fee = 138 * this._config.networkFee; // FIXME: Use from transaction
        const txAmount = Math.floor(deductFees ? amount - fee : amount);
        if (txAmount > 0) {
            Nimiq.Log.i(PoolPayout, `PAYING ${Nimiq.Policy.satoshisToCoins(txAmount)} NIM to ${recipientAddress.toUserFriendlyAddress()}`);
            const tx = this.wallet.createTransaction(recipientAddress, txAmount, fee, this.consensus.blockchain.height);
            await this._storePayout(recipientId, amount, Date.now(), tx.hash());
            await this.consensus.mempool.pushTransaction(tx);

            // TODO remove payouts that are never mined into a block
        }
    }

    /**
     * @returns {Promise.<Array.<{userAddress: Nimiq.Address, userId: number, amount: number}>>}
     * @private
     */
    async _getAutoPayouts() {
        const query = `
            SELECT user.id AS user_id, user.address AS user_address, IFNULL(payin_sum, 0) AS payin_sum, IFNULL(payout_sum, 0) AS payout_sum
            FROM (
                (
                    SELECT user, SUM(amount) AS payin_sum
                    FROM payin
                    INNER JOIN block ON block.id = payin.block
                    WHERE block.main_chain = true AND block.height <= ?
                    GROUP BY payin.user
                ) t1
                LEFT JOIN
                (
                    SELECT user, SUM(amount) AS payout_sum
                    FROM payout
                    GROUP BY user
                ) t2
                ON t2.user = t1.user
                LEFT JOIN user ON user.id = t1.user
            )
            WHERE payin_sum - IFNULL(payout_sum, 0) > ?`;
        const blocksConfirmedHeight = this.consensus.blockchain.height - this._config.payoutConfirmations;
        const queryArgs = [blocksConfirmedHeight, this._config.autoPayOutLimit];
        const [rows, fields] = await this.connectionPool.execute(query, queryArgs);

        const ret = [];
        for (const row of rows) {
            ret.push({
                userAddress: Nimiq.Address.fromBase64(row.user_address),
                userId: row.user_id,
                amount: row.payin_sum - row.payout_sum
            });
        }
        return ret;
    }

    /**
     * @returns {Promise.<Array.<{userAddress: Nimiq.Address, userId: number}>>}
     * @private
     */
    async _getPayoutRequests() {
        const query = `
            SELECT user, address
            FROM payout_request
            LEFT JOIN user ON payout_request.user = user.id`;
        const [rows, fields] = await this.connectionPool.execute(query);

        let ret = [];
        for (const row of rows) {
            ret.push({
                userAddress: Nimiq.Address.fromBase64(row.address),
                userId: row.user
            });
        }
        return ret;
    }

    /**
     * @param {number} userId
     * @private
     */
    async _removePayoutRequest(userId) {
        const query = `DELETE FROM payout_request WHERE user=?`;
        const queryArgs = [userId];
        await this.connectionPool.execute(query, queryArgs);
    }

    async _validatePayins() {
        const query = `
            SELECT block.hash AS hash, SUM(payin.amount) AS payin_sum
            FROM payin
            INNER JOIN block ON block.id = payin.block
            WHERE block.main_chain = true
            GROUP BY block.hash`;
        const [rows, fields] = await this.connectionPool.execute(query);

        for (const row of rows) {
            const hashBuf = new Nimiq.SerialBuffer(Uint8Array.from(row.hash));
            const hash = Nimiq.Hash.unserialize(hashBuf);
            const block = await this.consensus.blockchain.getBlock(hash, false, true);
            if (!block.minerAddr.equals(this.wallet.address)) {
                Nimiq.Log.e(PoolPayout, `Wrong miner address in block ${block.hash()} ${block.minerAddr} != ${this.wallet.address}`);
                return false;
            }
            const payableBlockReward = Helper.getPayableBlockReward(this._config, block);
            if (row.payin_sum > payableBlockReward) {
                Nimiq.Log.e(PoolPayout, `Stored payins are greater than the payable block reward for block ${block.hash()}`);
                return false;
            }
        }
        return true;
    }

    /**
     * @param {number} userId
     * @param {number} amount
     * @param {number} datetime
     * @param {Nimiq.Hash} transactionHash
     * @returns {Promise.<void>}
     * @private
     */
    async _storePayout(userId, amount, datetime, transactionHash) {
        const query = 'INSERT INTO payout (user, amount, datetime, transaction) VALUES (?, ?, ?, ?)';
        const queryArgs = [userId, amount, datetime, transactionHash.serialize()];
        await this.connectionPool.execute(query, queryArgs);
    }

    /**
     * @type {Wallet}
     * */
    get wallet() {
        return this._wallet;
    }

    /**
     * @type {BaseConsensus}
     * */
    get consensus() {
        return this._consensus;
    }
}

module.exports = exports = PoolPayout;
