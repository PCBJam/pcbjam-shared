CREATE TABLE IF NOT EXISTS plugin_request_nonce (
  issuer text NOT NULL, audience text NOT NULL, jti text NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY (issuer,audience,jti)
);
CREATE TABLE IF NOT EXISTS plugin_preference (
  issuer text NOT NULL, subject text NOT NULL, library text NOT NULL,
  PRIMARY KEY (issuer,subject)
);
-- Housekeeping, e.g. daily: retain expired nonces for a day beyond token validity.
-- DELETE FROM plugin_request_nonce WHERE expires_at < now() - interval '1 day';
