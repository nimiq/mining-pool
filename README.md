# Nimiq Mining-Pool Server

> **Important: Running a mining-pool in the mainnet means you are responsible for other people's money**
>
> By running a mining-pool in the mainnet, your are resonsible for other people's money and are responsible for paying it out, or you will become liable for their losses. Always test your pool implementation and server in the testnet, that is what the testnet is for.

## Requirements
* An internet-accessible domain with a valid SSL certificate
* A MySQL-compatible database, such as MySQL, MariaDB
* Cron jobs to make your life easier

## Architecure
The Nimiq Mining-Pool Server consists of three parts:
1. Pool Server
2. Pool Service
3. Pool Payout

### Pool Server
The server manages connected miners, validates their shares and inserts their shares into the database.

### Pool Service
The service comes into action when a block is mined by the pool and distributes the block reward amongst the last n shares.
> The pool service can be run together with the pool server in the same process. Simply combine their config files to run them together.

### Pool Payout
The payout process is meant to be run separately from the other processes and relays payout transactions into the network according to user balances.

## Important Tipps
* Both the server/service and the separate payout processes need to be full nodes.
* The payout process exits automatically after it finished, so it needs to be restarted for each payout. This is by design.
* One way to run the payout regularily is to set up a CRON job for it.
* The payout process needs to run with access to the same database as the server/service, but can potentially run on a separate server.
* If all processes run on the same server, remember to separate their consensus databases by running them in different working directories.
* To be able to send transactions, the payout process needs to know the private key of the pool wallet. Therefore you can either put the wallet seed into the payout config file or come up with other means to protect the pool's funds.
* Transaction fees for automatic payouts above the `autoPayOutLimit` are paid by the pool. Thus you have to balance many and often payouts with the fees you pay for those payouts as the pool owner.

## Setup
1. Clone the Nimiq core repository, checkout the `marvin/pool` branch and run `yarn` or `npm install`.
   (The core repository is expected to be accessible from the mining-pool directory as `../core/`.)
2. Clone this `mining-pool` repository
3. Execute `create.sql` on your database engine. It sets up the database, tables and users.
4. Configure the PoolServer, the PoolService and the PoolPayout.
   The PoolServer and PoolService can be run together in one process; combine their configs for this.
5. Run `mining-pool/index.js --config <your config file>` to start the respective server/service/payout.

## Configuration

### General
The following general parameters can be configured:

| Parameter | Description |
| --- | --- |
| name | The name of your pool, will be written into the extra data field of mined blocks |
| address | Your pool's user-friendly address |
| payoutConfirmations | How many confirmations are requried for user's balance to be confirmed |
| autoPayOutLimit | Minimum confirmed balance in nimtoshis for auto-payouts |
| poolFee | Pool fee, in 1/100: 1% = 0.01 |
| networkFee | Nimtoshis per byte to set as transaction fee for payouts |
| minDifficulty | Minimum share difficulty for connected clients. The share difficulty is adjusted to closely match the `desiredSps` |
| spsTimeUnit | How often SPS are evaluated, in milliseconds |
| desiredSps | Desired shares-per-second for connected miners. The share difficulty is adjusted accordingly. |

### Server
| Parameter | Description |
| --- | --- |
| enabled | If server should be enabled, propably `true` |
| port | On which port miners should connect |
| sslCertPath | Path to your SSL cert or fullchain |
| sslKeyPath | Path to your SSL private key |
| mySqlPsw | The password of the `pool_server` MySQL user, if any |
| mySqlHost | The host of the MySQL server, usually `localhost` |

### Service
| Parameter | Description |
| --- | --- |
| enabled | If service should be enabled, propably `true` |
| mySqlPsw | The password of the `pool_service` MySQL user, if any |
| mySqlHost | The host of the MySQL server, usually `localhost` |

### Payout
| Parameter | Description |
| --- | --- |
| enabled | If payout should be enabled, propably `true` in the payout config |
| mySqlPsw | The password of the `pool_payout` MySQL user, if any |
| mySqlHost | The host of the MySQL server, usually `localhost` |
