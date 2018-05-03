const Nimiq = require('@nimiq/core');
const https = require('https');
const WebSocket = require('uws');
const mysql = require('mysql2/promise');
const fs = require('fs');

const PoolAgent = require('./PoolAgent.js');
const Helper = require('./Helper.js');

class PoolServer extends Nimiq.Observable {
    /**
     * @param {Nimiq.FullConsensus} consensus
     * @param {PoolConfig} config
     * @param {number} port
     * @param {string} mySqlPsw
     * @param {string} mySqlHost
     * @param {string} sslKeyPath
     * @param {string} sslCertPath
     */
    constructor(consensus, config, port, mySqlPsw, mySqlHost, sslKeyPath, sslCertPath) {
        super();

        /** @type {Nimiq.FullConsensus} */
        this._consensus = consensus;

        /** @type {string} */
        this.name = config.name;

        /** @type {Nimiq.Address} */
        this.poolAddress = Nimiq.Address.fromUserFriendlyAddress(config.address);

        /** @type {PoolConfig} */
        this._config = config;

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
        this._miner = new Nimiq.Miner(consensus.blockchain, consensus.blockchain.accounts, consensus.mempool, consensus.network.time, this.poolAddress);

        /** @type {Set.<PoolAgent>} */
        this._agents = new Set();

        /** @type {Nimiq.HashMap.<Nimiq.NetAddress, number>} */
        this._bannedIPv4IPs = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Uint8Array, number>} */
        this._bannedIPv6IPs = new Nimiq.HashMap();

        /** @type {number} */
        this._numBlocksMined = 0;

        /** @type {number} */
        this._totalShareDifficulty = 0;

        /** @type {number} */
        this._lastShareDifficulty = 0;

        /** @type {number[]} */
        this._hashrates = [];

        /** @type {number} */
        this._averageHashrate = 0;

        /** @type {boolean} */
        this._started = false;

        setInterval(() => this._checkUnbanIps(), PoolServer.UNBAN_IPS_INTERVAL);

        setInterval(() => this._calculateHashrate(), PoolServer.HASHRATE_INTERVAL);

        this.consensus.on('established', () => this.start());
    }

    async start() {
        if (this._started) return;
        this._started = true;

        this._currentLightHead = this.consensus.blockchain.head.toLight();
        await this._updateTransactions();

        this.connectionPool = await mysql.createPool({
            host: this._mySqlHost,
            user: 'pool_server',
            password: this._mySqlPsw,
            database: 'pool'
        });

        this._wss = PoolServer.createServer(this.port, this._sslKeyPath, this._sslCertPath);
        this._wss.on('connection', (ws, req) => this._onConnection(ws, req));

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

        // We have to access socket.remoteAddress here because otherwise req.connection.remoteAddress won't be set in the WebSocket's 'connection' event (yay)
        httpsServer.on('secureConnection', socket => socket.remoteAddress);

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
     * @param {http.IncomingMessage} req
     * @private
     */
    _onConnection(ws, req) {
        try {
            let netAddress = Nimiq.NetAddress.fromIP(req.connection.remoteAddress);
            if (req.headers['x-forwarded-for']) {
                // Some proxy services append their own IP to the end of the header value,
                // but we only need the origin IP, so we take the first IP of the potential list
                const ip = req.headers['x-forwarded-for'].split(/\s*,\s*/)[0];
                netAddress = Nimiq.NetAddress.fromIP(ip);
            }

            if (this._isIpBanned(netAddress)) {
                Nimiq.Log.i(PoolServer, `Banned IP tried to connect ${netAddress}`);
                ws.close();
            } else {
                const agent = new PoolAgent(this, ws, netAddress);
                agent.on('share', (header, difficulty) => this._onShare(header, difficulty));
                agent.on('block', (header) => this._onBlock(header));
                this._agents.add(agent);
            }
        } catch (e) {
            Nimiq.Log.e(PoolServer, e);
            ws.close();
        }
    }

    /**
     * @param {Nimiq.BlockHeader} header
     * @param {number} difficulty
     * @private
     */
    _onShare(header, difficulty) {
        this._totalShareDifficulty += difficulty;
    }

    /**
     * @param {BlockHeader} header
     * @private
     */
    _onBlock(header) {
        this._numBlocksMined++;
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
            if (poolAgent.mode === PoolAgent.Mode.NANO) {
                poolAgent.updateBlock(this._currentLightHead, this._nextTransactions, this._nextPrunedAccounts, this._nextAccountsHash);
            }
        }
    }

    /**
     * @param {Nimiq.NetAddress} netAddress
     */
    banIp(netAddress) {
        if (!netAddress.isPrivate()) {
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
        if (netAddress.isPrivate()) return false;
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

    _calculateHashrate() {
        if (!this.consensus.established) return;

        const shareDifficulty = this._totalShareDifficulty - this._lastShareDifficulty;
        this._lastShareDifficulty = this._totalShareDifficulty;

        const hashrate = shareDifficulty / (PoolServer.HASHRATE_INTERVAL / 1000) * Math.pow(2 ,16);
        this._hashrates.push(Math.round(hashrate));
        if (this._hashrates.length > 10) this._hashrates.shift();

        let hashrateSum = 0;
        for (const hr of this._hashrates) {
            hashrateSum += hr;
        }
        this._averageHashrate = hashrateSum / this._hashrates.length;

        Nimiq.Log.d(PoolServer, `Pool hashrate is ${Math.round(this._averageHashrate)} H/s (10 min average)`);
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
        const query = "INSERT INTO share (user, device, datetime, prev_block, difficulty, hash) VALUES (?, ?, ?, ?, ?, ?)";
        const queryArgs = [userId, deviceId, Date.now(), prevHashId, difficulty, shareHash.serialize()];
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
        return await Helper.getUserBalance(this._config, this.connectionPool, userId, this.consensus.blockchain.height, includeVirtual);
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
     * @type {{ unregistered: number, smart: number, nano: number}}
     */
    getClientModeCounts() {
        let unregistered = 0, smart = 0, nano = 0;
        for (const agent of this._agents) {
            switch (agent.mode) {
                case PoolAgent.Mode.SMART:
                    smart++;
                    break;
                case PoolAgent.Mode.NANO:
                    nano++;
                    break;
                case PoolAgent.Mode.UNREGISTERED:
                    unregistered++;
                    break;
            }
        }
        return { unregistered: unregistered, smart: smart, nano: nano };
    }

    /**
     * @type {Nimiq.FullConsensus}
     * */
    get consensus() {
        return this._consensus;
    }

    /** @type {PoolConfig} */
    get config() {
        return this._config;
    }

    /**
     * @type {number}
     */
    get numIpsBanned() {
        return this._bannedIPv4IPs.length + this._bannedIPv6IPs.length;
    }

    /**
     * @type {number}
     */
    get numBlocksMined() {
        return this._numBlocksMined;
    }

    /**
     * @type {number}
     */
    get totalShareDifficulty() {
        return this._totalShareDifficulty;
    }

    /**
     * @type {number}
     */
    get averageHashrate() {
        return this._averageHashrate;
    }
}
PoolServer.DEFAULT_BAN_TIME = 1000 * 60 * 10; // 10 minutes
PoolServer.UNBAN_IPS_INTERVAL = 1000 * 60; // 1 minute
PoolServer.HASHRATE_INTERVAL = 1000 * 60; // 1 minute

module.exports = exports = PoolServer;
