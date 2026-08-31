"use client";

// 作品详情页（/work?id=<script_id>）：剧本大封面 + 简介 + 观看正片跳转。
// 静态导出场景用查询参数（?id=）而非动态路由段，免 generateStaticParams。
// useSearchParams 在 Next 14 预渲染下必须包 <Suspense>。

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, type ScriptDetail } from "@/lib/api";

function WorkBody() {
  const sp = useSearchParams();
  const id = sp.get("id");
  const [script, setScript] = useState<ScriptDetail | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    api<ScriptDetail>(`/scripts/${encodeURIComponent(id)}`)
      .then(setScript)
      .catch((e) => setErr(e instanceof Error ? e.message : "加载失败"))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px 40px" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <Link href="/" style={{ fontSize: 14, fontWeight: 700, color: "var(--primary)", textDecoration: "none" }}>← 返回 DramaX</Link>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>作品详情</span>
      </header>

      {loading && <p style={{ textAlign: "center", color: "var(--muted)", padding: 40 }}>加载中…</p>}

      {!loading && !id && (
        <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>🎬</div>
          缺少作品参数（?id=剧本ID）
        </div>
      )}

      {!loading && id && err && (
        <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>🎞️</div>
          {err === "not found" ? "作品不存在或已下架" : err}
        </div>
      )}

      {!loading && script && (
        <article>
          {script.cover_url ? (
            <img
              src={script.cover_url}
              alt={script.title}
              loading="lazy"
              style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 14, background: "#f3f4f6", display: "block" }}
            />
          ) : (
            <div style={{ width: "100%", aspectRatio: "1 / 1", borderRadius: 14, background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 56 }}>🎬</div>
          )}

          <h1 style={{ fontSize: 22, margin: "16px 0 6px", lineHeight: 1.3 }}>{script.title}</h1>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            {script.category && <span className="tag">{script.category}</span>}
            {script.episodes != null && <span className="tag">{script.episodes} 集</span>}
            <span className="tag">{script.created_at?.slice(0, 10)}</span>
          </div>

          {script.synopsis && (
            <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--muted)", whiteSpace: "pre-wrap" }}>{script.synopsis}</p>
          )}

          {script.work_url && (
            <a
              href={script.work_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                e.preventDefault();
                window.open(script.work_url!, "_blank", "noopener");
              }}
              style={{
                display: "block", marginTop: 20, padding: "14px 0", textAlign: "center",
                background: "var(--primary)", color: "#fff", borderRadius: 12,
                fontSize: 15, fontWeight: 700, textDecoration: "none",
              }}
            >
              观看正片 ↗
            </a>
          )}
        </article>
      )}
    </main>
  );
}

export default function WorkPage() {
  return (
    <Suspense fallback={<main style={{ maxWidth: 480, margin: "0 auto", padding: 40, textAlign: "center", color: "var(--muted)" }}>加载中…</main>}>
      <WorkBody />
    </Suspense>
  );
}
