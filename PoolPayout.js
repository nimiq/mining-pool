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
    }

    async start() {
        this.connectionPool = await mysql.createPool({
            host: this._mySqlHost,
            user: 'nimpool_payout',
            password: this._mySqlPsw,
            database: 'nimpool'
        });
        this.consensus.on('established', async () => {
            await this._processPayouts();
            process.exit(0);
        });
    }

    async _processPayouts() {
        const payinsValid = await this._validatePayins();
        if (!payinsValid) {
            throw new Error('Payin inconsistency');
        }

        const autoPayouts = await this._getAutoPayouts();
        for (const userAddress of autoPayouts.keys()) {
            await this._payout(userAddress, autoPayouts.get(userAddress), false);
        }
        const payoutRequests = await this._getPayoutRequests();
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
            this.consensus.mempool.pushTransaction(tx);

            // TODO remove payouts that are never mined into a block
        }
    }

    /**
     * @returns {Promise.<Map.<Nimiq.Address,number>>}
     * @private
     */
    async _getAutoPayouts() {
        const query = `
            SELECT t1.user AS user, IFNULL(payin_sum, 0) AS payin_sum, IFNULL(payout_sum, 0) AS payout_sum
            FROM (
                (
                    SELECT user, block, SUM(amount) AS payin_sum
                    FROM (
                        (
                            SELECT user, block, amount
                            FROM payin
                        ) t3
                        INNER JOIN
                        (
                            SELECT id, height
                            FROM block
                            WHERE main_chain=true
                            ORDER BY height DESC
                        ) t4
                        ON t4.id = t3.block
                    )
                    WHERE height <= ?
                    GROUP BY user
                ) t1
                LEFT JOIN 
                (
                    SELECT user, SUM(amount) AS payout_sum
                    FROM payout
                    GROUP BY user
                ) t2
                ON t1.user = t2.user
            )
            WHERE payin_sum - IFNULL(payout_sum, 0) > ?
        `;
        const queryArgs = [this.consensus.blockchain.height - this._config.payoutConfirmations, this._config.autoPayOutLimit];
        const [rows, fields] = await this.connectionPool.execute(query, queryArgs);

        const ret = new Map();
        for (const row of rows) {
            ret.set(await Helper.getUser(this.connectionPool, row.user), row.payin_sum - row.payout_sum);
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
            SELECT hash, SUM(amount) AS payin_sum
            FROM (
                (
                    SELECT user, block, amount
                    FROM payin
                ) t3
                INNER JOIN
                (
                    SELECT id, hash
                    FROM block
                    WHERE main_chain=true
                ) t4
                ON t4.id = t3.block
            )
            GROUP BY block
        `;
        const [rows, fields] = await this.connectionPool.execute(query);

        for (const row of rows) {
            const hashBuf = new Nimiq.SerialBuffer(Uint8Array.from(row.hash));
            const hash = Nimiq.Hash.unserialize(hashBuf);
            const block = await this.consensus.blockchain.getBlock(hash, false, true);
            if (!block.minerAddr.equals(this.wallet.address)) {
                return false;
            }
            let payableBlockReward = Helper.getPayableBlockReward(this._config, block);
            if (row.payin_sum > payableBlockReward) {
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
