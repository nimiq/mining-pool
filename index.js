const Nimiq = require('@nimiq/core');
const argv = require('minimist')(process.argv.slice(2));
const config = require('./src/Config.js')(argv.config);

const PoolServer = require('./src/PoolServer.js');
const PoolService = require('./src/PoolService.js');
const PoolPayout = require('./src/PoolPayout.js');
const MetricsServer = require('./src/MetricsServer.js');

const START = Date.now();
const TAG = 'Node';
const $ = {};

if (!config) {
    Nimiq.Log.e(TAG, 'Specify a valid config file with --config=FILE');
    process.exit(1);
}
if (config.poolServer.enabled && config.type !== 'full') {
    Nimiq.Log.e(TAG, 'Pool server must run as a \'full\' node');
    process.exit(1);
}
if (config.poolPayout.enabled && (config.poolServer.enabled || config.poolService.enabled)) {
    Nimiq.Log.e(TAG, 'Pool payout needs to run separately from pool server');
    process.exit(1);
}

Nimiq.Log.instance.level = config.log.level;
for (const tag in config.log.tags) {
    Nimiq.Log.instance.setLoggable(tag, config.log.tags[tag]);
}

for (const key in config.constantOverrides) {
    Nimiq.ConstantHelper.instance.set(key, config.constantOverrides[key]);
}

Nimiq.GenesisConfig.init(Nimiq.GenesisConfig.CONFIGS[config.network]);

for (const seedPeer of config.seedPeers) {
    Nimiq.GenesisConfig.SEED_PEERS.push(Nimiq.WsPeerAddress.seed(seedPeer.host, seedPeer.port, seedPeer.publicKey));
}

(async () => {
    const networkConfig = config.dumb
        ? new Nimiq.DumbNetworkConfig()
        : new Nimiq.WsNetworkConfig(config.host, config.port, config.tls.key, config.tls.cert);

    switch (config.type) {
        case 'full':
            $.consensus = await Nimiq.Consensus.full(networkConfig);
            break;
        case 'light':
            $.consensus = await Nimiq.Consensus.light(networkConfig);
            break;
        case 'nano':
            $.consensus = await Nimiq.Consensus.nano(networkConfig);
            break;
    }

    $.blockchain = $.consensus.blockchain;
    $.accounts = $.blockchain.accounts;
    $.mempool = $.consensus.mempool;
    $.network = $.consensus.network;

    Nimiq.Log.i(TAG, `Peer address: ${networkConfig.peerAddress.toString()} - public key: ${networkConfig.keyPair.publicKey.toHex()}`);

    // TODO: Wallet key.
    $.walletStore = await new Nimiq.WalletStore();
    if (!config.wallet.seed) {
        // Load or create default wallet.
        $.wallet = await $.walletStore.getDefault();
    } else if (config.wallet.seed) {
        // Load wallet from seed.
        const mainWallet = await Nimiq.Wallet.loadPlain(config.wallet.seed);
        await $.walletStore.put(mainWallet);
        await $.walletStore.setDefault(mainWallet.address);
        $.wallet = mainWallet;
    }

    if (config.poolServer.enabled) {
        const poolServer = new PoolServer($.consensus, config.pool, config.poolServer.port, config.poolServer.mySqlPsw, config.poolServer.mySqlHost, config.poolServer.sslKeyPath, config.poolServer.sslCertPath);

        if (config.poolMetricsServer.enabled) {
            $.metricsServer = new MetricsServer(config.poolServer.sslKeyPath, config.poolServer.sslCertPath, config.poolMetricsServer.port, config.poolMetricsServer.password);
            $.metricsServer.init(poolServer);
        }

        process.on('SIGTERM', () => {
            poolServer.stop();
            process.exit(0);
        });
        process.on('SIGINT', () => {
            poolServer.stop();
            process.exit(0);
        });
    }
    if (config.poolService.enabled) {
        const poolService = new PoolService($.consensus, config.pool, config.poolService.mySqlPsw, config.poolService.mySqlHost);
        poolService.start();
    }
    if (config.poolPayout.enabled) {
        const wallet = await $.walletStore.get(Nimiq.Address.fromString(config.pool.address));
        if (!wallet) Nimiq.Log.i(TAG, 'Wallet for pool address not found, will fallback to default wallet for payouts.');
        const poolPayout = new PoolPayout($.consensus, wallet || $.wallet, config.pool, config.poolPayout.mySqlPsw, config.poolPayout.mySqlHost);
        poolPayout.start();
    }

    const addresses = await $.walletStore.list();
    Nimiq.Log.i(TAG, `Managing wallets [${addresses.map(address => address.toUserFriendlyAddress())}]`);

    const isNano = config.type === 'nano';
    const account = !isNano ? await $.accounts.get($.wallet.address) : null;
    Nimiq.Log.i(TAG, `Wallet initialized for address ${$.wallet.address.toUserFriendlyAddress()}.`
        + (!isNano ? ` Balance: ${Nimiq.Policy.satoshisToCoins(account.balance)} NIM` : ''));

    Nimiq.Log.i(TAG, `Blockchain state: height=${$.blockchain.height}, headHash=${$.blockchain.headHash}`);

    $.blockchain.on('head-changed', (head) => {
        if ($.consensus.established || head.height % 100 === 0) {
            Nimiq.Log.i(TAG, `Now at block: ${head.height}`);
        }
    });

    $.network.on('peer-joined', (peer) => {
        Nimiq.Log.i(TAG, `Connected to ${peer.peerAddress.toString()}`);
    });

    $.consensus.on('established', () => {
        Nimiq.Log.i(TAG, `Blockchain ${config.type}-consensus established in ${(Date.now() - START) / 1000}s.`);
        Nimiq.Log.i(TAG, `Current state: height=${$.blockchain.height}, totalWork=${$.blockchain.totalWork}, headHash=${$.blockchain.headHash}`);
    });

    $.network.connect();
})().catch(e => {
    console.error(e);
    process.exit(1);
});
