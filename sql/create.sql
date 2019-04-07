CREATE DATABASE pool;

CREATE USER 'pool_payout'@'localhost';
CREATE USER 'pool_service'@'localhost';
CREATE USER 'pool_server'@'localhost';
CREATE USER 'pool_info'@'localhost';

CREATE TABLE pool.user (
  id           INTEGER     PRIMARY KEY NOT NULL AUTO_INCREMENT,
  address      VARCHAR(64) NOT NULL UNIQUE
);
CREATE INDEX idx_user_address ON pool.user (address);

CREATE TABLE pool.block (
  id           INTEGER    PRIMARY KEY NOT NULL AUTO_INCREMENT,
  hash         BINARY(32) NOT NULL UNIQUE,
  height       INTEGER    NOT NULL,
  datetime     BIGINT     NOT NULL,
  main_chain   BOOLEAN    NOT NULL DEFAULT false
);

CREATE INDEX idx_block_hash ON pool.block (hash);
CREATE INDEX idx_block_height ON pool.block (height);

CREATE TABLE pool.shares (
  id           INTEGER    PRIMARY KEY NOT NULL AUTO_INCREMENT,
  user         INTEGER    NOT NULL REFERENCES pool.user(id),
  device       INTEGER    UNSIGNED NOT NULL,
  prev_block   INTEGER    NOT NULL REFERENCES pool.block(id),
  count        INTEGER    NOT NULL,
  difficulty   DOUBLE     NOT NULL,
  UNIQUE(user, device, prev_block)
);

CREATE INDEX idx_share_prev ON pool.shares (prev_block);

CREATE TABLE pool.payin (
  id           INTEGER    PRIMARY KEY NOT NULL AUTO_INCREMENT,
  user         INTEGER    NOT NULL REFERENCES pool.user(id),
  amount       DOUBLE     NOT NULL,
  block        INTEGER    NOT NULL REFERENCES pool.block(id),
  UNIQUE(user, block)
);

CREATE TABLE pool.payout (
  id           INTEGER    PRIMARY KEY NOT NULL AUTO_INCREMENT,
  user         INTEGER       NOT NULL REFERENCES pool.user(id),
  amount       DOUBLE     NOT NULL,
  datetime     BIGINT     NOT NULL,
  transaction  BINARY(32)
);

CREATE TABLE pool.payout_request (
  id           INTEGER    PRIMARY KEY NOT NULL AUTO_INCREMENT,
  user         INTEGER    NOT NULL UNIQUE REFERENCES pool.user(id)
);

DELIMITER //

CREATE PROCEDURE pool.StoreUserId(IN address VARCHAR(64), OUT user_id INTEGER)
SQL SECURITY INVOKER
BEGIN
    SELECT id INTO user_id FROM user WHERE user.address = address;
    IF ISNULL(user_id) THEN
        INSERT IGNORE INTO user (address) VALUES (address);
        SELECT id INTO user_id FROM user WHERE user.address = address;
    END IF;
END //

CREATE PROCEDURE pool.GetStoreUserId(IN address VARCHAR(64))
SQL SECURITY INVOKER
BEGIN
    CALL pool.StoreUserId(address, @user_id);
    SELECT @user_id AS id;
END //

CREATE PROCEDURE pool.StoreBlockId(IN hash BINARY(32), IN height INTEGER, IN datetime INTEGER, OUT block_id INTEGER)
SQL SECURITY INVOKER
BEGIN
    SELECT id INTO block_id FROM block WHERE block.hash = hash;
    IF ISNULL(block_id) THEN
        INSERT IGNORE INTO block (hash, height, datetime) VALUES (hash, height, datetime);
        SELECT id INTO block_id FROM block WHERE block.hash = hash;
    END IF;
END //

CREATE PROCEDURE pool.GetStoreBlockId(IN hash BINARY(32), IN height INTEGER, IN datetime INTEGER)
SQL SECURITY INVOKER
BEGIN
    CALL pool.StoreBlockId(hash, height,datetime, @block_id);
    SELECT @block_id AS id;
END //

DELIMITER ;

GRANT SELECT,INSERT ON pool.user TO 'pool_server'@'localhost';
GRANT SELECT ON pool.user TO 'pool_service'@'localhost';
GRANT SELECT ON pool.user TO 'pool_payout'@'localhost';
GRANT SELECT ON pool.user TO 'pool_info'@'localhost';

GRANT SELECT,INSERT ON pool.block TO 'pool_server'@'localhost';
GRANT SELECT,INSERT,UPDATE ON pool.block TO 'pool_service'@'localhost';
GRANT SELECT ON pool.block TO 'pool_payout'@'localhost';
GRANT SELECT ON pool.block TO 'pool_info'@'localhost';

GRANT SELECT,INSERT,UPDATE ON pool.shares TO 'pool_server'@'localhost';
GRANT SELECT,DELETE ON pool.shares TO 'pool_service'@'localhost';
GRANT SELECT ON pool.shares TO 'pool_info'@'localhost';

GRANT SELECT ON pool.payin TO 'pool_server'@'localhost';
GRANT SELECT,INSERT,DELETE ON pool.payin TO 'pool_service'@'localhost';
GRANT SELECT ON pool.payin TO 'pool_payout'@'localhost';
GRANT SELECT ON pool.payin TO 'pool_info'@'localhost';

GRANT SELECT ON pool.payout TO 'pool_server'@'localhost';
GRANT SELECT,INSERT ON pool.payout TO 'pool_service'@'localhost';
GRANT SELECT,INSERT ON pool.payout TO 'pool_payout'@'localhost';
GRANT SELECT ON pool.payout TO 'pool_info'@'localhost';

GRANT SELECT,INSERT,DELETE ON pool.payout_request TO 'pool_server'@'localhost';
GRANT SELECT,DELETE ON pool.payout_request TO 'pool_payout'@'localhost';
GRANT SELECT ON pool.payout_request TO 'pool_info'@'localhost';

GRANT EXECUTE ON pool.* TO 'pool_server'@'localhost';
GRANT EXECUTE ON pool.* TO 'pool_service'@'localhost';
