-- 0004: 剧本表新增封面图片与作品访问地址字段（demo 级轻量方案）
-- cover_url：封面缩略图 URL（无图时前端显示占位块）；work_url：作品正片跳转地址（可空）

ALTER TABLE scripts ADD COLUMN cover_url TEXT;  -- 封面图片 URL
ALTER TABLE scripts ADD COLUMN work_url TEXT;   -- 作品访问地址（如短剧正片页）
