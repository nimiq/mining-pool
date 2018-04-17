const Nimiq = require('../core/dist/node.js');
const https = require('https');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const fs = require('fs');

const PoolAgent = require('./PoolAgent.js');
const Helper = require('./Helper.js');

class PoolServer extends Nimiq.Observable {
    /**
     * @param {Nimiq.FullConsensus} consensus
     * @param {string} name
     * @param {Nimiq.Address} poolAddress
     * @param {number} port
     * @param {string} mySqlPsw
     * @param {string} mySqlHost
     * @param {string} sslKeyPath
     * @param {string} sslCertPath
     */
    constructor(consensus, name, poolAddress, port, mySqlPsw, mySqlHost, sslKeyPath, sslCertPath) {
        super();

        /** @type {Nimiq.FullConsensus} */
        this._consensus = consensus;

        /** @type {string} */
        this.name = name;

        /** @type {Nimiq.Address} */
        this.poolAddress = poolAddress;

        /** @type {number} */
        this.port = port;

        /** @type {string} */
        this._mySqlPsw = mySqlPsw;

        /** @type {string} */
        this._mySqlHost = mySqlHost;

        /** @type {string} */
        this._sslKeyPath = sslKeyPath;

        /** @type {string} */
        this._sslCertPath = sslCertPath;

        /** @type {Nimiq.Miner} */
        this._miner = new Nimiq.Miner(consensus.blockchain, consensus.blockchain.accounts, consensus.mempool, consensus.network.time, poolAddress);

        /** @type {Set.<PoolAgent>} */
        this._agents = new Set();

        /** @type {Nimiq.HashMap.<NetAddress, number>} */
        this._bannedIPv4IPs = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Uint8Array, number>} */
        this._bannedIPv6IPs = new Nimiq.HashMap();

        setInterval(() => this._checkUnbanIps(), PoolServer.UNBAN_IPS_INTERVAL);

        this.consensus.on('established', () => this.start());
    }

    async start() {
        this._currentLightHead = this.consensus.blockchain.head.toLight();
        await this._updateTransactions();

        this.connectionPool = await mysql.createPool({
            host: this._mySqlHost,
            user: 'nimpool_server',
            password: this._mySqlPsw,
            database: 'nimpool'
        });

        this._wss = PoolServer.createServer(this.port, this._sslKeyPath, this._sslCertPath);
        this._wss.on('connection', ws => this._onConnection(ws));

        this.consensus.blockchain.on('head-changed', (head) => this._announceHeadToNano(head));
    }

    static createServer(port, sslKeyPath, sslCertPath) {
        const sslOptions = {
            key: fs.readFileSync(sslKeyPath),
            cert: fs.readFileSync(sslCertPath)
        };
        const httpsServer = https.createServer(sslOptions, (req, res) => {
            res.writeHead(200);
            res.end('Nimiq Pool Server\n');
        }).listen(port);
        Nimiq.Log.i(PoolServer, "Started server on port " + port);
        return new WebSocket.Server({server: httpsServer});
    }

    stop() {
        if (this._wss) {
            this._wss.close();
        }
    }

    /**
     * @param {WebSocket} ws
     * @private
     */
    _onConnection(ws) {
        const netAddress = Nimiq.NetAddress.fromIP(ws._socket.remoteAddress);
        if (this._isIpBanned(netAddress)) {
            Nimiq.Log.i(PoolServer, `Banned IP tried to connect ${netAddress}`);
            ws.close();
        } else {
            const agent = new PoolAgent(this, ws);
            this._agents.add(agent);
        }
    }

    /**
     * @param {PoolAgent} agent
     */
    requestCurrentHead(agent) {
        agent.updateBlock(this._currentLightHead, this._nextTransactions, this._nextPrunedAccounts, this._nextAccountsHash);
    }

    /**
     * @param {Nimiq.BlockHead} head
     * @private
     */
    async _announceHeadToNano(head) {
        this._currentLightHead = head.toLight();
        await this._updateTransactions();
        this._announceNewNextToNano();
    }

    async _updateTransactions() {
        try {
            const block = await this._miner.getNextBlock();
            this._nextTransactions = block.body.transactions;
            this._nextPrunedAccounts = block.body.prunedAccounts;
            this._nextAccountsHash = block.header._accountsHash;
        } catch(e) {
            setTimeout(() => this._updateTransactions(), 100);
        }
    }

    _announceNewNextToNano() {
        for (const poolAgent of this._agents.values()) {
            if (poolAgent.mode && poolAgent.mode === PoolAgent.MODE_NANO) {
                poolAgent.updateBlock(this._currentLightHead, this._nextTransactions, this._nextPrunedAccounts, this._nextAccountsHash);
            }
        }
    }

    /**
     * @param {WebSocket} ws
     */
    ban(ws) {
        const netAddress = Nimiq.NetAddress.fromIP(ws._socket.remoteAddress);
        this._banIp(netAddress);
        ws.close();
    }

    /**
     * @param {Nimiq.NetAddress} netAddress
     * @private
     */
    _banIp(netAddress) {
        if (!netAddress.isPseudo()) {
            Nimiq.Log.i(PoolServer, `Banning IP ${netAddress}`);
            if (netAddress.isIPv4()) {
                this._bannedIPv4IPs.put(netAddress, Date.now() + PoolServer.DEFAULT_BAN_TIME);
            } else if (netAddress.isIPv6()) {
                // Ban IPv6 IPs prefix based
                this._bannedIPv6IPs.put(netAddress.ip.subarray(0,8), Date.now() + PoolServer.DEFAULT_BAN_TIME);
            }
        }
    }

    /**
     * @param {Nimiq.NetAddress} netAddress
     * @returns {boolean}
     * @private
     */
    _isIpBanned(netAddress) {
        if (netAddress.isPseudo()) return false;
        if (netAddress.isIPv4()) {
            return this._bannedIPv4IPs.contains(netAddress);
        } else if (netAddress.isIPv6()) {
            const prefix = netAddress.ip.subarray(0, 8);
            return this._bannedIPv6IPs.contains(prefix);
        }
        return false;
    }

    _checkUnbanIps() {
        const now = Date.now();
        for (const netAddress of this._bannedIPv4IPs.keys()) {
            if (this._bannedIPv4IPs.get(netAddress) < now) {
                this._bannedIPv4IPs.remove(netAddress);
            }
        }
        for (const prefix of this._bannedIPv6IPs.keys()) {
            if (this._bannedIPv6IPs.get(prefix) < now) {
                this._bannedIPv6IPs.remove(prefix);
            }
        }
    }

    /**
     * @param {number} userId
     * @param {number} deviceId
     * @param {Nimiq.Hash} prevHash
     * @param {number} prevHashHeight
     * @param {number} difficulty
     * @param {Nimiq.Hash} shareHash
     */
    async storeShare(userId, deviceId, prevHash, prevHashHeight, difficulty, shareHash) {
        let prevHashId = await Helper.getStoreBlockId(this.connectionPool, prevHash, prevHashHeight);
        const query = "INSERT INTO share (user, device, prev_block, difficulty, hash) VALUES (?, ?, ?, ?, ?)";
        const queryArgs = [userId, deviceId, prevHashId, difficulty, shareHash.serialize()];
        await this.connectionPool.execute(query, queryArgs);
    }

    /**
     * @param {number} user
     * @param {string} shareHash
     * @returns {boolean}
     */
    async containsShare(user, shareHash) {
        const query = "SELECT * FROM share WHERE user=? AND hash=?";
        const queryArgs = [user, shareHash.serialize()];
        const [rows, fields] = await this.connectionPool.execute(query, queryArgs);
        return rows.length > 0;
    }

    /**
     * @param {number} userId
     * @param {boolean} includeVirtual
     * @returns {Promise<number>}
     */
    async getUserBalance(userId, includeVirtual = false) {
        return await Helper.getUserBalance(this.connectionPool, userId, this.consensus.blockchain.height, includeVirtual);
    }

    /**
     * @param {number} userId
     */
    async storePayoutRequest(userId) {
        const query = "INSERT IGNORE INTO payout_request (user) VALUES (?)";
        const queryArgs = [userId];
        await this.connectionPool.execute(query, queryArgs);
    }

    /**
     * @param {number} userId
     * @returns {Promise.<boolean>}
     */
    async hasPayoutRequest(userId) {
        const query = `SELECT * FROM payout_request WHERE user=?`;
        const [rows, fields] = await this.connectionPool.execute(query, [userId]);
        return rows.length > 0;
    }

    /**
     * @param {Nimiq.Address} addr
     * @returns {Promise.<number>}
     */
    async getStoreUserId(addr) {
        await this.connectionPool.execute("INSERT IGNORE INTO user (address) VALUES (?)", [addr.toBase64()]);
        const [rows, fields] = await this.connectionPool.execute("SELECT id FROM user WHERE address=?", [addr.toBase64()]);
        return rows[0].id;
    }

    /**
     * @param {PoolAgent} agent
     */
    removeAgent(agent) {
        this._agents.delete(agent);
    }

    /**
     * @type {Nimiq.FullConsensus}
     * */
    get consensus() {
        return this._consensus;
    }
}
PoolServer.DEFAULT_BAN_TIME = 1000 * 60 * 10; // 10 minutes
PoolServer.UNBAN_IPS_INTERVAL = 1000 * 60; // 1 minute
//TODO connection timeout!
PoolServer.CONNECTION_TIMEOUT = 1000 * 60 * 3; // 3 min

module.exports = exports = PoolServer;
