import { useMemo } from 'react';
import type { ParsedFont } from '../types';
import {
  buildResilienceReport,
  type ChainLike,
  type FontFailureResult,
} from '../lib/resilience';
import { displayCluster, formatCodepoint } from '../lib/grapheme';
import { downloadText } from '../lib/audit';

interface ResiliencePanelProps {
  results: FontFailureResult[];
  baselineChain: ChainLike[];
  validFonts: ParsedFont[];
  lengthPriority: number;
  ignoreFormat: boolean;
  useMeasured: boolean;
}

const RISK_HIGH = '高风险';
const RISK_MED = '中风险';
const RISK_LOW = '可兜底';
const RISK_IDLE = '无承接';

/** 风险分级：有新增缺失为高/中风险；全部可兜底为低风险；本就零承接为无承接 */
function riskLevel(r: FontFailureResult): { label: string; cls: string } {
  if (r.newMissingCount > 0) {
    return r.newMissingCount >= 3
      ? { label: RISK_HIGH, cls: 'high' }
      : { label: RISK_MED, cls: 'medium' };
  }
  if (r.baselineAssigned === 0) return { label: RISK_IDLE, cls: 'idle' };
  return { label: RISK_LOW, cls: 'low' };
}

function fmtDelta(d: number): string {
  if (d > 0) return `+${d}`;
  return String(d);
}

/** 单字体失效韧性分析：风险卡片（按新增缺失簇数排序） */
export default function ResiliencePanel({
  results,
  baselineChain,
  validFonts,
  lengthPriority,
  ignoreFormat,
  useMeasured,
}: ResiliencePanelProps) {
  const generatedAt = useMemo(() => new Date().toISOString(), [results]);

  const jsonText = useMemo(
    () =>
      JSON.stringify(
        buildResilienceReport(results, baselineChain, validFonts, {
          lengthPriority,
          ignoreFormatCodepoints: ignoreFormat,
          useMeasuredCoverage: useMeasured,
          generatedAt,
        }),
        null,
        2,
      ),
    [results, baselineChain, validFonts, lengthPriority, ignoreFormat, useMeasured, generatedAt],
  );

  if (results.length === 0) {
    return (
      <p className="muted small">
        当前最优回退链为空 —— 请先添加至少一种范围有效的字体并完成求解。
      </p>
    );
  }

  return (
    <div className="resilience">
      <p className="muted small resilience-intro">
        依次模拟链中每种字体<strong>完全不可用</strong>，保持原始偏好顺序与当前
        {useMeasured ? '实测' : '声明'}覆盖模式，在剩余字体上重新求解。卡片按
        <strong>新增缺失簇数</strong>从高到低排序。
      </p>

      <div className="risk-grid">
        {results.map((r) => {
          const risk = riskLevel(r);
          return (
            <article key={r.failedFontIndex} className={`risk-card risk-${risk.cls}`}>
              <header className="risk-head">
                <div className="risk-title">
                  <span className="risk-font">{r.name || '(未命名)'}</span>
                  <span className="muted small mono">偏好 #{r.preference + 1}</span>
                </div>
                <span className={`risk-badge ${risk.cls}`}>{risk.label}</span>
              </header>

              <div className="risk-stats">
                <div className={`risk-stat${r.newMissingCount ? ' bad' : ''}`}>
                  <span className="risk-stat-num">{r.newMissingCount}</span>
                  <span className="risk-stat-label">新增缺失簇</span>
                </div>
                <div className="risk-stat">
                  <span className="risk-stat-num">{r.baselineAssigned}</span>
                  <span className="risk-stat-label">原承接簇</span>
                </div>
                <div className="risk-stat">
                  <span className="risk-stat-num mono">{fmtDelta(r.chainLengthDelta)}</span>
                  <span className="risk-stat-label">
                    链长 {r.chainLengthBefore} → {r.chainLengthAfter}
                  </span>
                </div>
              </div>

              {r.newMissing.length > 0 && (
                <p className="risk-line bad-text">
                  新增缺失：
                  {r.newMissing.slice(0, 10).map((c) => (
                    <span
                      key={c.index}
                      className="missing-chip"
                      title={c.missingCodepoints.map(formatCodepoint).join(' ')}
                    >
                      {displayCluster(c.text)}
                    </span>
                  ))}
                  {r.newMissing.length > 10 && ` 等 ${r.newMissing.length} 簇`}
                </p>
              )}

              {r.takenOver.length > 0 && (
                <p className="risk-line">
                  由其他字体承接：
                  {r.takenOver.map((t) => (
                    <span key={t.fontIndex} className="takeover-chip">
                      {t.name || '(未命名)'} ×{t.clusterCount}
                    </span>
                  ))}
                </p>
              )}

              {r.newMissingCount === 0 && r.takenOver.length === 0 && (
                <p className="risk-line muted small">
                  {r.baselineAssigned === 0
                    ? '该字体在基线链中未实际承接任何簇，失效无影响。'
                    : '其承接簇全部可被替代字体接住。'}
                </p>
              )}

              <details className="risk-details">
                <summary className="small">
                  替代回退链（{r.chainLengthAfter} 项{r.exact ? '，精确解' : '，启发式解'}）
                  {r.otherReassignments.length > 0 &&
                    ` · ${r.otherReassignments.length} 簇连带改配`}
                </summary>
                <ol className="alt-chain-list mono">
                  {r.replacementChain.map((e, i) => (
                    <li key={e.fontIndex}>
                      <span className="alt-order">{i + 1}.</span>
                      <span className="alt-name">{e.name || '(未命名)'}</span>
                      {e.newlyJoined && <span className="join-badge">链外加入</span>}
                      <span className="muted small">
                        #{e.preference + 1} · 承接 {e.assignedClusters} 簇
                      </span>
                    </li>
                  ))}
                  {r.replacementChain.length === 0 && (
                    <li className="muted small">无替代字体可选</li>
                  )}
                </ol>
                {r.otherReassignments.length > 0 && (
                  <p className="muted small risk-extra">
                    连带改配：
                    {r.otherReassignments.slice(0, 6).map((c) => (
                      <span key={c.index} className="reassign-chip">
                        {displayCluster(c.text)}：{validFonts[c.fromFontIndex].name || '(未命名)'} →{' '}
                        {validFonts[c.toFontIndex].name || '(未命名)'}
                      </span>
                    ))}
                    {r.otherReassignments.length > 6 &&
                      ` 等 ${r.otherReassignments.length} 簇`}
                  </p>
                )}
                {r.newMissing.length > 0 && (
                  <p className="muted small risk-extra">
                    失效后缺失簇总数 {r.missingAfterCount}（含基线本就缺失的簇）。
                  </p>
                )}
              </details>
            </article>
          );
        })}
      </div>

      <div className="resilience-export">
        <button
          className="btn small primary"
          onClick={() => downloadText('font-fallback-resilience.json', jsonText)}
        >
          下载韧性分析 JSON
        </button>
        <span className="muted small">
          含每种字体失效后的新增缺失簇、承接字体、连带改配与替代回退链（含原始偏好位次与索引）。
        </span>
      </div>
    </div>
  );
}
