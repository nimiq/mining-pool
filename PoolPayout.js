const Nimiq = require('../core/dist/node.js');
const mysql = require('mysql2/promise');

const Helper = require('./Helper.js');
const PoolConfig = require('./PoolConfig.js');

class PoolPayout extends Nimiq.Observable {
    /**
     * @param {Nimiq.BaseConsensus} consensus
     * @param {Nimiq.Wallet} wallet
     * @param {string} mySqlPsw
     */
    constructor(consensus, wallet, mySqlPsw, mySqlHost) {
        super();
        /** @type {Nimiq.BaseConsensus} */
        this._consensus = consensus;

        /** @type {Nimiq.Wallet} */
        this._wallet = wallet;

        /** @type {string} */
        this._mySqlPsq = mySqlPsw;

        /** @type {string} */
        this._mySqlHost = _mySqlHost;
    }

    async start() {
        this.connection = await mysql.createConnection({
            host: this._mySqlHost,
            user: 'nimpool_payout',
            password: this._mySqlPsq,
            database: 'nimpool'
        });
        this.consensus.on('established', () => this._processPayouts());
    }

    async _processPayouts() {
        const autoPayouts = await this._getAutoPayouts();
        for (let userAddress of autoPayouts.keys()) {
            await this._payout(userAddress, autoPayouts.get(userAddress), false);
        }
        const payoutRequests = await this._getPayoutRequests();
        for (let userId of payoutRequests) {
            const balance = await Helper.getUserBalance(this.connection, userId, this.consensus.blockchain.height);
            const user = await Helper.getUser(this.connection, userId);
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
        const txAmount = Math.floor(deductFees ? amount - PoolConfig.NETWORK_FEE : amount);
        if (txAmount > 0) {
            Nimiq.Log.i(PoolPayout, "PAYING " + txAmount / Nimiq.Policy.SATOSHIS_PER_COIN + " NIM to " + recipientAddress.toUserFriendlyAddress());
            const tx = this.wallet.createTransaction(recipientAddress, txAmount, 137 * PoolConfig.NETWORK_FEE, this.consensus.blockchain.height);
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
                    SELECT user, SUM(amount) as payout_sum
                    FROM payout
                    GROUP BY user
                ) t2
                ON t1.user = t2.user
            )
            WHERE payin_sum - IFNULL(payout_sum, 0) > ?
        `;
        const queryArgs = [this._consensus.blockchain.height - PoolConfig.CONFIRMATIONS, PoolConfig.AUTO_PAY_OUT];
        const [rows, fields] = await this.connection.execute(query, queryArgs);

        const ret = new Map();
        for (let row of rows) {
            ret.set(await Helper.getUser(this.connection, row.user), row.payin_sum - row.payout_sum);
        }
        return ret;
    }

    /**
     * @returns {Promise.<Array.<number>>}
     * @private
     */
    async _getPayoutRequests() {
        const query = `SELECT * from payout_request`;
        const [rows, fields] = await this.connection.execute(query);

        let ret = [];
        for (let row of rows) {
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
        await this.connection.execute(query, queryArgs);
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
        const query = "INSERT INTO payout (user, amount, datetime, transaction) VALUES (?, ?, ?, ?)";
        const queryArgs = [await Helper.getUserId(this.connection, recipientAddress), amount, datetime, transactionHash.serialize()];
        await this.connection.execute(query, queryArgs);
    }

    /**
     * @type {Nimiq.Wallet}
     * */
    get wallet() {
        return this._wallet;
    }

    /**
     * @type {Nimiq.FullConsensus}
     * */
    get consensus() {
        return this._consensus;
    }
}

module.exports = exports = PoolPayout;
