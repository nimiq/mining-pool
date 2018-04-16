CREATE DATABASE nimpool;

CREATE USER 'nimpool_payout'@'localhost';
CREATE USER 'nimpool_service'@'localhost';
CREATE USER 'nimpool_server'@'localhost';

CREATE TABLE nimpool.user (
  id           INTEGER     PRIMARY KEY NOT NULL AUTO_INCREMENT,
  address      VARCHAR(64) NOT NULL UNIQUE
);
CREATE INDEX idx_user_address ON nimpool.user (address);

CREATE TABLE nimpool.block (
  id           INTEGER    PRIMARY KEY NOT NULL AUTO_INCREMENT,
  hash         BINARY(32) NOT NULL UNIQUE,
  height       INTEGER    NOT NULL,
  main_chain   BOOLEAN    NOT NULL DEFAULT false
);
CREATE INDEX idx_block_hash ON nimpool.block (hash);
CREATE INDEX idx_block_height ON nimpool.block (height);

CREATE TABLE nimpool.share (
  id           INTEGER    PRIMARY KEY NOT NULL AUTO_INCREMENT,
  user         INTEGER    NOT NULL REFERENCES nimpool.user(id),
  device       INTEGER    UNSIGNED NOT NULL,
  prev_block   INTEGER    NOT NULL REFERENCES nimpool.block(id),
  difficulty   DOUBLE     NOT NULL,
  hash         BINARY(32) NOT NULL UNIQUE
);

CREATE INDEX idx_share_prev ON nimpool.share (prev_block);
CREATE INDEX idx_share_hash ON nimpool.share (hash);

CREATE TABLE nimpool.payin (
  id           INTEGER    PRIMARY KEY NOT NULL AUTO_INCREMENT,
  user         INTEGER    NOT NULL REFERENCES nimpool.user(id),
  amount       DOUBLE     NOT NULL,
  datetime     BIGINT     NOT NULL,
  block        INTEGER    NOT NULL REFERENCES nimpool.block(id),
  UNIQUE(user, block)
);

CREATE TABLE nimpool.payout (
  id           INTEGER    PRIMARY KEY NOT NULL AUTO_INCREMENT,
  user         INTEGER       NOT NULL REFERENCES nimpool.user(id),
  amount       DOUBLE     NOT NULL,
  datetime     BIGINT     NOT NULL,
  transaction  BINARY(32)
);

CREATE TABLE nimpool.payout_request (
  id           INTEGER    PRIMARY KEY NOT NULL AUTO_INCREMENT,
  user         INTEGER    NOT NULL UNIQUE REFERENCES nimpool.user(id)
);

GRANT SELECT,INSERT ON nimpool.user TO 'nimpool_server'@'localhost';
GRANT SELECT ON nimpool.user TO 'nimpool_service'@'localhost';
GRANT SELECT ON nimpool.user TO 'nimpool_payout'@'localhost';

GRANT SELECT,INSERT ON nimpool.block TO 'nimpool_server'@'localhost';
GRANT SELECT,INSERT,UPDATE ON nimpool.block TO 'nimpool_service'@'localhost';
GRANT SELECT ON nimpool.block TO 'nimpool_payout'@'localhost';

GRANT SELECT,INSERT ON nimpool.share TO 'nimpool_server'@'localhost';
GRANT SELECT ON nimpool.share TO 'nimpool_service'@'localhost';

GRANT SELECT ON nimpool.payin TO 'nimpool_server'@'localhost';
GRANT SELECT,INSERT,DELETE ON nimpool.payin TO 'nimpool_service'@'localhost';
GRANT SELECT ON nimpool.payin TO 'nimpool_payout'@'localhost';

GRANT SELECT ON nimpool.payout TO 'nimpool_server'@'localhost';
GRANT SELECT,INSERT ON nimpool.payout TO 'nimpool_service'@'localhost';
GRANT SELECT,INSERT ON nimpool.payout TO 'nimpool_payout'@'localhost';

GRANT SELECT,INSERT,DELETE ON nimpool.payout_request TO 'nimpool_server'@'localhost';
GRANT SELECT,DELETE ON nimpool.payout_request TO 'nimpool_payout'@'localhost';
