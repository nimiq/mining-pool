const mysql = require('mysql2/promise');

const Nimiq = require('@nimiq/core');

const PoolAgent = require('../src/PoolAgent.js');
const PoolServer = require('../src/PoolServer.js');

describe('PoolAgent', () => {

    beforeEach(() => {
        spyOn(PoolServer, 'createServer').and.callFake(() => {
            return {
                on: () => {},
                close: () => {}
            };
        });
    });

    async function generateBlockMessage(minerAddr, extraData, fixTime, target) {
        const nonces = {
            's4Xy6xUCf/WegBZhQTUdN5zq1knUpXLMyqDMyuaGsjU=': 225614,
            '4ulvVBd/xJU1VdbQo2nzkPZVrBErxIYDNMHLLj51KPQ=': 12188,
            '/Txmmo6uRktXSQCQ8P5OqDXo3iXdDmb4LZ7veHotXq8=': 28027
        };
        const accounts = await Nimiq.Accounts.createVolatile();
        const transactionStore = await Nimiq.TransactionStore.createVolatile();
        const blockchain = await Nimiq.FullChain.createVolatile(accounts, fixTime, transactionStore);
        const mempool = new Nimiq.Mempool(blockchain, accounts);
        const miner = new Nimiq.Miner(blockchain, accounts, mempool, fixTime, minerAddr, extraData);
        const block = await miner.getNextBlock();
        const blockHeader64 = block.header.hash().toBase64();
        // console.log(blockHeader64);
        // miner.shareTarget = target;
        // miner.on('share', async (block) => {
        //     console.log(block);
        // });
        // miner.startWork();
        block.header.nonce = nonces[blockHeader64];

        return {
            message: 'share',
            blockHeader: Nimiq.BufferUtils.toBase64(block.header.serialize()),
            minerAddrProof: Nimiq.BufferUtils.toBase64((Nimiq.MerklePath.compute(block.body.getMerkleLeafs(), block.minerAddr)).serialize()),
            extraDataProof: Nimiq.BufferUtils.toBase64((Nimiq.MerklePath.compute(block.body.getMerkleLeafs(), block.body.extraData)).serialize())
        };
    }

    it('verifies shares (smart mode)', (done) => {
        (async () => {
            const consensus = await Nimiq.Consensus.volatileFull();
            const poolServer = new PoolServer(consensus, POOL_CONFIG, 9999, '', '', '', '');
            await poolServer.start();

            const time = new Nimiq.Time();
            spyOn(time, 'now').and.callFake(() => 0);

            const poolAgent = new PoolAgent(poolServer, {
                close: () => {},
                send: async (json) => {
                    const msg = JSON.parse(json);
                    if (msg.message === 'settings') {
                        const poolAddress = Nimiq.Address.fromUserFriendlyAddress(msg.address);
                        const extraData = Nimiq.BufferUtils.fromBase64(msg.extraData);
                        const target = parseFloat(msg.target);

                        let userId = await poolServer.getStoreUserId(NQ43sampleData.address);

                        // valid share
                        let shareMsg = await generateBlockMessage(poolAddress, extraData, time, target);
                        await poolAgent._onMessage(shareMsg);
                        let hash = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(shareMsg.blockHeader)).hash();
                        expect(await poolServer.containsShare(userId, hash)).toBeTruthy();

                        // wrong miner address
                        shareMsg = await generateBlockMessage(Nimiq.Address.fromUserFriendlyAddress('NQ57 LUAL 6R8F ETD3 VE77 6NK5 HEUK 009H C06B'), extraData, time, target);
                        await poolAgent._onMessageData(JSON.stringify(shareMsg));
                        hash = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(shareMsg.blockHeader)).hash();
                        expect(await poolServer.containsShare(userId, hash)).toBeFalsy();

                        // wrong extra data
                        shareMsg = await generateBlockMessage(poolAddress, Nimiq.BufferUtils.fromAscii('wrong'), time, target);
                        await poolAgent._onMessageData(JSON.stringify(shareMsg));
                        hash = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(shareMsg.blockHeader)).hash();
                        expect(await poolServer.containsShare(userId, hash)).toBeFalsy();

                        done();
                    }
                }
            }, Nimiq.NetAddress.fromIP('1.2.3.4'));
            await poolAgent._onMessage(NQ43sampleData.register);
        })().catch(done.fail);
    });

    it('does not alow to submit shares twice (smart mode)', (done) => {
        (async () => {
            const consensus = await Nimiq.Consensus.volatileFull();
            const poolServer = new PoolServer(consensus, POOL_CONFIG, 9999, '', '', '', '');
            await poolServer.start();

            const time = new Nimiq.Time();
            spyOn(time, 'now').and.callFake(() => 0);

            const poolAgent = new PoolAgent(poolServer, {
                close: () => {},
                send: async (json) => {
                    const msg = JSON.parse(json);
                    if (msg.message === 'settings') {
                        const poolAddress = Nimiq.Address.fromUserFriendlyAddress(msg.address);
                        const extraData = Nimiq.BufferUtils.fromBase64(msg.extraData);
                        const target = parseFloat(msg.target);

                        let userId = await poolServer.getStoreUserId(NQ43sampleData.address);

                        // valid share
                        let shareMsg = await generateBlockMessage(poolAddress, extraData, time, target);
                        await poolAgent._onMessage(shareMsg);
                        let hash = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(shareMsg.blockHeader)).hash();
                        expect(await poolServer.containsShare(userId, hash)).toBeTruthy();

                        // Submit valid share twice
                        try {
                            await poolAgent._onMessage(shareMsg);
                        } catch (e) {
                            done();
                        }
                    }
                }
            }, Nimiq.NetAddress.fromIP('1.2.3.4'));
            await poolAgent._onMessage(NQ43sampleData.register);
        })().catch(done.fail);
    });

    it('does not count shares onto old blocks (smart mode)', (done) => {
        (async () => {
            const consensus = await Nimiq.Consensus.volatileFull();
            const poolServer = new PoolServer(consensus, POOL_CONFIG, 9999, '', '', '', '');
            await poolServer.start();

            let fixFakeTime = 0;
            const time = new Nimiq.Time();
            spyOn(time, 'now').and.callFake(() => fixFakeTime);

            const poolAgent = new PoolAgent(poolServer, {
                close: () => {},
                send: async (json) => {
                    const msg = JSON.parse(json);
                    if (msg.message === 'settings') {
                        const poolAddress = Nimiq.Address.fromUserFriendlyAddress(msg.address);
                        const extraData = Nimiq.BufferUtils.fromBase64(msg.extraData);
                        const target = parseFloat(msg.target);

                        let userId = await poolServer.getStoreUserId(NQ43sampleData.address);

                        // valid share
                        let shareMsg = await generateBlockMessage(poolAddress, extraData, time, target);
                        await poolAgent._onMessage(shareMsg);
                        let hash = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(shareMsg.blockHeader)).hash();
                        expect(await poolServer.containsShare(userId, hash)).toBeTruthy();

                        fixFakeTime = 2000;
                        shareMsg = await generateBlockMessage(poolAddress, extraData, time, target);
                        await poolAgent._onMessage(shareMsg);
                        hash = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(shareMsg.blockHeader)).hash();
                        expect(await poolServer.containsShare(userId, hash)).toBeTruthy();

                        done();
                    }
                }
            }, Nimiq.NetAddress.fromIP('1.2.3.4'));
            await poolAgent._onMessage(NQ43sampleData.register);
        })().catch(done.fail);
    });

    it('bans clients with too many invalid shares', (done) => {
        (async () => {
            const consensus = await Nimiq.Consensus.volatileFull();
            const poolServer = new PoolServer(consensus, POOL_CONFIG, 9999, '', '', '', '');
            await poolServer.start();
            const time = new Nimiq.Time();
            spyOn(time, 'now').and.callFake(() => 0);

            let settingsMsg;
            const poolAgent = new PoolAgent(poolServer, {
                close: () => { },
                send: async (json) => {
                    const msg = JSON.parse(json);
                    if (msg.message === 'settings') {
                        settingsMsg = msg;
                    } else if (msg.message == 'balance') {
                        const extraData = Nimiq.BufferUtils.fromBase64(settingsMsg.extraData);
                        const target = parseFloat(settingsMsg.target);

                        poolServer.config.allowedErrors = 2;

                        expect(poolServer.numIpsBanned).toEqual(0);
                        for (let i = 0; i < poolServer.config.allowedErrors + 1; i++) {
                            // wrong miner address, won't be stored and won't ban instantly
                            shareMsg = await generateBlockMessage(Nimiq.Address.fromUserFriendlyAddress('NQ57 LUAL 6R8F ETD3 VE77 6NK5 HEUK 009H C06B'), extraData, time, target);
                            await poolAgent._onMessageData(JSON.stringify(shareMsg));
                        }
                        expect(poolServer.numIpsBanned).toEqual(1);
                        done();
                    }
                }
            }, Nimiq.NetAddress.fromIP('1.2.3.4'));
            await poolAgent._onMessage(NQ43sampleData.register);
        })().catch(done.fail);
    });

    it('handles payout requests', (done) => {
        (async () => {
            const keyPair = Nimiq.KeyPair.generate();
            const clientAddress = keyPair.publicKey.toAddress();

            const consensus = await Nimiq.Consensus.volatileFull();
            const poolServer = new PoolServer(consensus, POOL_CONFIG, 9999, '', 'localhost', '', '');
            await poolServer.start();
            const poolAgent = new PoolAgent(poolServer, { close: () => {}, send: () => {} }, Nimiq.NetAddress.fromIP('1.2.3.4'));
            spyOn(poolAgent, '_regenerateNonce').and.callFake(() => { poolAgent._nonce = 42 });

            const registerMsg = {
                message: 'register',
                address: clientAddress.toUserFriendlyAddress(),
                deviceId: 111111111,
                mode: 'smart',
                genesisHash: Nimiq.BufferUtils.toBase64(Nimiq.GenesisConfig.GENESIS_HASH.serialize())
            };
            await poolAgent._onMessage(registerMsg);

            async function sendSignedPayoutRequest(usedKeyPair) {
                let buf = new Nimiq.SerialBuffer(8 + PoolAgent.PAYOUT_NONCE_PREFIX.length);
                buf.writeString(PoolAgent.PAYOUT_NONCE_PREFIX, PoolAgent.PAYOUT_NONCE_PREFIX.length);
                buf.writeUint64(42);
                let signature = Nimiq.Signature.create(usedKeyPair.privateKey, usedKeyPair.publicKey, buf);
                return Nimiq.SignatureProof.singleSig(usedKeyPair.publicKey, signature);
            }

            const connection = await mysql.createConnection({ host: 'localhost', user: 'root', password: 'root', database: 'pool', multipleStatements: true });

            // garbage signature
            let request = { message: 'payout', proof: 'AAAAAAAAAAAAAAAAAAaaaaaaaa' };
            await poolAgent._onMessageData(JSON.stringify(request));

            let userId = await poolServer.getStoreUserId(clientAddress);
            let [rows, fields] = await connection.execute('SELECT * FROM payout_request WHERE user=?', [userId]);
            expect(rows.length).toEqual(0);

            // invalid signature
            signatureProof = await sendSignedPayoutRequest(Nimiq.KeyPair.generate());
            request = { message: 'payout', proof: Nimiq.BufferUtils.toBase64(signatureProof.serialize()) };
            await poolAgent._onMessageData(JSON.stringify(request));

            userId = await poolServer.getStoreUserId(clientAddress);
            [rows, fields] = await connection.execute('SELECT * FROM payout_request WHERE user=?', [userId]);
            expect(rows.length).toEqual(0);

            // valid signature
            signatureProof = await sendSignedPayoutRequest(keyPair);
            request = { message: 'payout', proof: Nimiq.BufferUtils.toBase64(signatureProof.serialize()) };
            await poolAgent._onMessage(request);

            userId = await poolServer.getStoreUserId(clientAddress);
            [rows, fields] = await connection.execute('SELECT * FROM payout_request WHERE user=?', [userId]);
            expect(rows.length).toEqual(1);

            done();
        })().catch(done.fail);
    });
});
