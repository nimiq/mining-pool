const Nimiq = require('../core/dist/node.js');
const mysql = require('mysql2/promise');

const Helper = require('./Helper.js');

class PoolPayout extends Nimiq.Observable {
    /**
     * @param {Nimiq.BaseConsensus} consensus
     * @param {Nimiq.Wallet} wallet
     * @param {PoolConfig} config
     * @param {string} mySqlPsw
     * @param {string} mySqlHost
     */
    constructor(consensus, wallet, config, mySqlPsw, mySqlHost) {
        super();
        /** @type {Nimiq.BaseConsensus} */
        this._consensus = consensus;

        /** @type {Nimiq.Wallet} */
        this._wallet = wallet;

        /** @type {PoolConfig} */
        this._config = config;

        /** @type {string} */
        this._mySqlPsw = mySqlPsw;

        /** @type {string} */
        this._mySqlHost = mySqlHost;

        /** @type {Nimiq.Timers} */
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
        Nimiq.Log.i(PoolPayout, `Processing ${autoPayouts.size} auto payouts`);
        for (const userAddress of autoPayouts.keys()) {
            await this._payout(userAddress, autoPayouts.get(userAddress), false);
        }

        const payoutRequests = await this._getPayoutRequests();
        Nimiq.Log.i(PoolPayout, `Processing ${payoutRequests.length} payout requests`);
        for (const userId of payoutRequests) {
            const balance = await Helper.getUserBalance(this._config, this.connectionPool, userId, this.consensus.blockchain.height);
            const user = await Helper.getUser(this.connectionPool, userId);
            await this._payout(user, balance, true);
            await this._removePayoutRequest(userId);
        }
    }

    /**
     * @param {Nimiq.Address} recipientAddress
     * @param {number} amount
     * @param {boolean} deductFees
     * @private
     */
    async _payout(recipientAddress, amount, deductFees) {
        const fee = 138 * this._config.networkFee; // FIXME: Use from transaction
        const txAmount = Math.floor(deductFees ? amount - fee : amount);
        if (txAmount > 0) {
            Nimiq.Log.i(PoolPayout, `PAYING ${Nimiq.Policy.satoshisToCoins(txAmount)} NIM to ${recipientAddress.toUserFriendlyAddress()}`);
            const tx = this.wallet.createTransaction(recipientAddress, txAmount, fee, this.consensus.blockchain.height);
            await this._storePayout(recipientAddress, amount, Date.now(), tx.hash());
            await this.consensus.mempool.pushTransaction(tx);

            // TODO remove payouts that are never mined into a block
        }
    }

    /**
     * @returns {Promise.<Map.<Nimiq.Address,number>>}
     * @private
     */
    async _getAutoPayouts() {
        const query = `
            SELECT IFNULL(payin_sum, 0) AS payin_sum, IFNULL(payout_sum, 0) AS payout_sum, address
            FROM (
                (
                    SELECT user, SUM(amount) AS payin_sum
                    FROM payin p
                    INNER JOIN block b ON b.id = p.block
                    WHERE b.main_chain = true AND b.height <= ?
                    GROUP BY p.user
                ) t1
                LEFT JOIN
                (
                    SELECT user, SUM(amount) AS payout_sum
                    FROM payout
                    GROUP BY user
                ) t2
                ON t2.user = t1.user
                LEFT JOIN user t3 ON t3.id = t1.user
            )
            WHERE payin_sum - payout_sum > ?`;
        const queryArgs = [this.consensus.blockchain.height - this._config.payoutConfirmations, this._config.autoPayOutLimit];
        const [rows, fields] = await this.connectionPool.execute(query, queryArgs);

        const ret = new Map();
        for (const row of rows) {
            ret.set(Nimiq.Address.fromBase64(row.address), row.payin_sum - row.payout_sum);
        }
        return ret;
    }

    /**
     * @returns {Promise.<Array.<number>>}
     * @private
     */
    async _getPayoutRequests() {
        const query = `SELECT * FROM payout_request`;
        const [rows, fields] = await this.connectionPool.execute(query);

        let ret = [];
        for (const row of rows) {
            ret.push(row.user);
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
            SELECT b.hash AS hash, SUM(p.amount) AS payin_sum
            FROM payin p
            INNER JOIN block b ON b.id = p.block
            WHERE b.main_chain = true
            GROUP BY p.block`;
        const [rows, fields] = await this.connectionPool.execute(query);

        for (const row of rows) {
            const hashBuf = new Nimiq.SerialBuffer(Uint8Array.from(row.hash));
            const hash = Nimiq.Hash.unserialize(hashBuf);
            const block = await this.consensus.blockchain.getBlock(hash, false, true);
            if (!block.minerAddr.equals(this.wallet.address)) {
                Nimiq.Log.e(PoolPayout, `Wrong miner address in block ${block.hash()}`);
                return false;
            }
            let payableBlockReward = Helper.getPayableBlockReward(this._config, block);
            if (row.payin_sum > payableBlockReward) {
                Nimiq.Log.e(PoolPayout, `Stored payins are greater than the payable block reward for block ${block.hash()}`);
                return false;
            }
        }
        return true;
    }

    /**
     * @param {Nimiq.Address} recipientAddress
     * @param {number} amount
     * @param {number} datetime
     * @param {Nimiq.Hash} transactionHash
     * @returns {Promise.<void>}
     * @private
     */
    async _storePayout(recipientAddress, amount, datetime, transactionHash) {
        const query = 'INSERT INTO payout (user, amount, datetime, transaction) VALUES (?, ?, ?, ?)';
        const queryArgs = [await Helper.getUserId(this.connectionPool, recipientAddress), amount, datetime, transactionHash.serialize()];
        await this.connectionPool.execute(query, queryArgs);
    }

    /**
     * @type {Nimiq.Wallet}
     * */
    get wallet() {
        return this._wallet;
    }

    /**
     * @type {Nimiq.BaseConsensus}
     * */
    get consensus() {
        return this._consensus;
    }
}

module.exports = exports = PoolPayout;
