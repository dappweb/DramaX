-- 0005: Testnet 演示剧本补封面与作品地址（仅 dramax-testnet 库使用，勿在生产库执行）
-- 封面：picsum 稳定随机图（seed=script id）；作品地址：mobile 端演示正片页
-- 前置：0004_cover_work_url.sql 已应用

UPDATE scripts SET cover_url = 'https://picsum.photos/seed/' || id || '/300/300',
                   work_url  = 'https://dramax-mobile.pages.dev/work/' || id
WHERE id IN ('script-01', 'script-02', 'script-03', 'script-04', 'script-05', 'script-06');
