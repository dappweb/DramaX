-- 0002: KV → D1 迁移表
-- 背景：账号免费版 KV 写入配额（1,000/天，账号级共享）被其他项目 cron 打满，
-- nonce put 失败导致登录 500。改用 D1（100k 行写/天）承载 KV 语义。
-- 统一 kv 表：key 主键 + value + expires_at（Unix 秒，NULL=永不过期）
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv (expires_at);
