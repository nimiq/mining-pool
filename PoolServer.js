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
     * @param {string} sslKeyPath
     * @param {string} sslCertPath
     */
    constructor(consensus, name, poolAddress, port, mySqlPsw, sslKeyPath, sslCertPath) {
        super();
        this._consensus = consensus;
        this.name = name;
        this.poolAddress = poolAddress;
        this.port = port;
        this.mySqlPsq = mySqlPsw;
        this.sslKeyPath = sslKeyPath;
        this.sslCertPath = sslCertPath;

        /** @type {Map.<number, PoolAgent>} */
        this._agents = new Map();

        /** @type {Nimiq.HashMap.<NetAddress, number>} */
        this._bannedIPv4IPs = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Uint8Array, number>} */
        this._bannedIPv6IPs = new Nimiq.HashMap();

        setInterval(() => this._checkUnbanIps(), PoolServer.UNBAN_IPS_INTERVAL);

        this._consensus.on('established', () => this.start());
    }

    async start() {
        this.connection = await mysql.createConnection({
            host: 'localhost',
            user: 'nimpool_server',
            password: this.mySqlPsq,
            database: 'nimpool'
        });

        const sslOptions = {
            key: fs.readFileSync(this.sslKeyPath),
            cert: fs.readFileSync(this.sslCertPath)
        };
        this._wss = PoolServer.createServer(this.port, sslOptions);
        this._wss.on('connection', ws => this._onConnection(ws));
    }

    static createServer(port, sslOptions) {
        console.log(port);
        const httpsServer = https.createServer(sslOptions, (req, res) => {
            res.writeHead(200);
            res.end('Nimiq Pool Server\n');
        }).listen(port);
        return new WebSocket.Server({server: httpsServer});
    }

    stop() {
        if (this._wss) {
            this._wss.close();
        }
    }

    _onConnection(ws) {
        const netAddress = Nimiq.NetAddress.fromIP(ws._socket.remoteAddress);
        if (this._isIpBanned(netAddress)) {
            console.log(`Banned IP tried to connect ${netAddress}`);
            ws.close();
        } else {
            const agent = new PoolAgent(this, ws);
            this._agents.set(agent.nonce, agent);
        }
    }

    ban(ws) {
        const netAddress = Nimiq.NetAddress.fromIP(ws._socket.remoteAddress);
        this._banIp(netAddress);
        ws.close();
    }

    /**
     * @param {number} userId
     * @param {Nimiq.Hash} prevHash
     * @param {number} prevHashHeight
     * @param {number} difficulty
     * @param {Nimiq.Hash} shareHash
     */
    async storeShare(userId, prevHash, prevHashHeight, difficulty, shareHash) {
        await this.connection.execute("INSERT IGNORE INTO block (hash, height) VALUES (?, ?)", [prevHash.serialize(), prevHashHeight]);
        const [rows, fields] = await this.connection.execute("SELECT id FROM block WHERE hash=?", [prevHash.serialize()]);
        let prevHashId = rows[0].id;
        const query = "INSERT INTO share (user, prev_block, difficulty, hash) VALUES (?, ?, ?, ?)";
        const queryArgs = [userId, prevHashId, difficulty, shareHash.serialize()];
        await this.connection.execute(query, queryArgs);
    }

    /**
     * @param {number} user
     * @param {string} shareHash
     * @returns {boolean}
     */
    async containsShare(user, shareHash) {
        const query = "SELECT * from share WHERE user=? and hash=?";
        const queryArgs = [user, shareHash.serialize()];
        const [rows, fields] = await this.connection.execute(query, queryArgs);
        return rows.length > 0;
    }

    /**
     * @param {number} userId
     * @param {boolean} includeVirtual
     * @returns {Promise<number>}
     */
    async getUserBalance(userId, includeVirtual = false) {
        return await Helper.getUserBalance(this.connection, userId, this._consensus.blockchain.height, includeVirtual);
    }

    async storePayoutRequest(userId) {
        const query = "INSERT IGNORE INTO payout_request (user) VALUES (?)";
        const queryArgs = [userId];
        await this.connection.execute(query, queryArgs);
    }

    /**
     * @param {Nimiq.Address} addr
     * @returns {Promise<number>}
     */
    async getStoreUserId(addr) {
        await this.connection.execute("INSERT IGNORE INTO user (address) VALUES (?)", [addr.toBase64()]);
        const [rows, fields] = await this.connection.execute("SELECT id FROM user WHERE address=?", [addr.toBase64()]);
        return rows[0].id;
    }

    /**
     * @param {PoolAgent} agent
     */
    removeAgent(agent) {
        this._agents.delete(agent.nonce);
    }

    /**
     * @param {Nimiq.NetAddress} netAddress
     * @returns {void}
     * @private
     */
    _banIp(netAddress) {
        if (!netAddress.isPseudo()) {
            console.log(`Banning IP ${netAddress}`);
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

    /**
     * @returns {void}
     * @private
     */
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

    /** @type {Nimiq.FullConsensus} */
    get consensus() {
        return this._consensus;
    }
}
PoolServer.DEFAULT_BAN_TIME = 1000 * 60 * 10; // 10 minutes
PoolServer.UNBAN_IPS_INTERVAL = 1000 * 60; // 1 minute

module.exports = exports = PoolServer;
