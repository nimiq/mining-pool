const Nimiq = require('@nimiq/core');
const mysql = require('mysql2/promise');

class PoolValidate extends Nimiq.Observable {
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
            this._validatePayouts();
            this.consensus.on('transaction-relayed', (tx) => {
                if (tx.sender.equals(this.wallet.address)) {
                    Nimiq.Log.i(PoolValidate, `Transaction relayed: ${tx.value} to ${tx.recipient.toUserFriendlyAddress()}`);
                }
            });
        });
        Nimiq.Log.i(PoolValidate, `Starting transaction validation for ${this.wallet.address.toUserFriendlyAddress()}`);
    }

    _quit() {
        Nimiq.Log.i(PoolValidate, 'Finished, exiting now.');
        process.exit(0);
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
            Nimiq.Log.i(PoolValidate, `PAYING ${Nimiq.Policy.satoshisToCoins(txAmount)} NIM to ${recipientAddress.toUserFriendlyAddress()}`);
            const tx = this.wallet.createTransaction(recipientAddress, txAmount, fee, this.consensus.blockchain.height);
            await this._storePayout(recipientId, amount, Date.now(), tx.hash());
            await this.consensus.mempool.pushTransaction(tx);

            // TODO remove payouts that are never mined into a block
        }
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

    async _validatePayouts() {
        const query = `
            SELECT payout.id AS id, transaction, amount, address, user.id AS user_id
            FROM payout
            INNER JOIN user ON user.id = payout.user`;
        const [rows, fields] = await this.connectionPool.execute(query);

        let missedTxs = 0;

        for (const row of rows) {
            const hashBuf = new Nimiq.SerialBuffer(Uint8Array.from(row.transaction));
            const hash = Nimiq.Hash.unserialize(hashBuf);
            const tx = await this.consensus.blockchain.getTransactionInfoByHash(hash);
            if (!tx) {
                missedTxs++;
                const address = Nimiq.Address.fromBase64(row.address);
                Nimiq.Log.w(PoolValidate, `Payout transaction not found: ${hash}, ${row.amount} to ${address.toUserFriendlyAddress()}`);
                await this._payout(row.user_id, address, row.amount, false);
                await this._removePayout(row.id);
            }
        }

        Nimiq.Log.i(PoolValidate, `Found ${missedTxs} missed transactions`);
        if (missedTxs < 1) this._quit();
    }

    async _removePayout(id) {
        const query = `
            DELETE FROM payout
            WHERE id = ?`;
        const queryArgs = [id];
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

module.exports = exports = PoolValidate;
