# Nimiq Mining-Pool Server
This mining pool server combines resources of multiple clients mining on the Nimiq blockchain. Clients are independent network nodes and generate or validate blocks themselves to support decentralization. Details about the mining pool protocol can be found [here](https://nimiq-network.github.io/developer-reference/chapters/pool-protocol.html#mining-pool-protocol). A mining pool client is implemented in the [core](https://github.com/nimiq-network/core).

## Architecture
The pool server consists of three parts which communicate through a database (schema see `sql/create.sql`)
* The pool **server** interacts with clients and verifies their shares. There can be multiple pool server instances.
* The pool **service** computes client rewards using a PPLNS reward system.
* The pool **payout** processes automatic payouts above a certain user balance and payout requests.

While the server(s) and the service are designed to run continuously, the pool payout has to be executed whenever a payout is desired.

## Run
Run `node index.js --config=[CONFIG_FILE]`. See `[server|service|payout].sample.conf` for sample configuration files and clarifications.
