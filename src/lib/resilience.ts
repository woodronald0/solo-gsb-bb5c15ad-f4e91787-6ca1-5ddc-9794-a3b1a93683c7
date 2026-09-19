/**
 * 单字体失效韧性分析。
 *
 * 对「当前最优回退链」中的每种字体，分别模拟该字体完全不可用：
 * - 保持用户原始偏好顺序（位次仍取整条字体列表中的原始 order）；
 * - 保持当前声明/实测覆盖模式（候选关系直接复用本次分析结果，不重新解析范围）；
 * - 在剩余「幸存字体」上重新执行同一求解器，得到替代回退链；
 * - 比较失效前后的承接结果，得出：
 *     · 新增缺失簇（原本可渲染、失效后无任何幸存字体可承接）；
 *     · 改由其他字体承接的簇（原由失效字体承接，现被幸存字体接住）；
 *     · 连带改配的簇（原本由别的链上字体承接，因链结构变化改配）；
 *     · 替代回退链（标注链外新加入的字体）与链长变化。
 *
 * 索引约定：本模块对外暴露的所有 fontIndex 都是「有效字体列表 validFonts」的
 * 原始下标。模拟失效时只构造 幸存局部下标 -> 原始下标的映射做求解，求解结果
 * 立即映射回原始下标后再输出，过滤字体不会导致名称/位次错配。
 */
import type { ClusterAudit, ParsedFont } from '../types';
import { findMissingCodepoints } from './coverage';
import { formatCodepoint } from './grapheme';
import { solveFallbackChain } from './solver';

/** 字素簇引用（界面与 JSON 共用） */
export interface ResilienceClusterRef {
  index: number;
  text: string;
}

/** 新增缺失的簇：附带无任何幸存字体覆盖的码位 */
export interface MissingClusterRef extends ResilienceClusterRef {
  missingCodepoints: number[];
}

/** 承接条目：某幸存字体接住了多少原由失效字体承接的簇 */
export interface TakeoverEntry {
  /** 承接字体的原始下标（validFonts） */
  fontIndex: number;
  name: string;
  /** 原始偏好位次 */
  preference: number;
  clusterCount: number;
  clusters: ResilienceClusterRef[];
}

/** 连带改配：原本由非失效字体承接，重解后改由另一字体承接 */
export interface ReassignmentRef extends ResilienceClusterRef {
  fromFontIndex: number;
  toFontIndex: number;
}

/** 替代回退链中的字体条目 */
export interface ReplacementChainEntry {
  fontIndex: number;
  name: string;
  preference: number;
  /** 是否为基线链之外新加入的字体 */
  newlyJoined: boolean;
  /** 重解后实际承接的簇数（不含仅含格式字符的 free 簇） */
  assignedClusters: number;
}

/** 单个字体失效的模拟结果（风险卡片数据） */
export interface FontFailureResult {
  /** 失效字体的原始下标（validFonts） */
  failedFontIndex: number;
  name: string;
  preference: number;
  /** 失效前该字体承接的簇数（不含 free 簇） */
  baselineAssigned: number;
  /** 新增缺失簇数（风险排序依据） */
  newMissingCount: number;
  newMissing: MissingClusterRef[];
  /** 原由失效字体承接、现被其他字体接住的簇（按承接量排序） */
  takenOver: TakeoverEntry[];
  /** 非失效字体承接的簇因链结构变化而连带改配 */
  otherReassignments: ReassignmentRef[];
  /** 替代回退链（按偏好顺序） */
  replacementChain: ReplacementChainEntry[];
  chainLengthBefore: number;
  chainLengthAfter: number;
  /** 替代链长 − 原链长（可为负：失效字体的独有簇全部缺失时链会变短） */
  chainLengthDelta: number;
  /** 重解后仍缺失的簇总数（含基线本就缺失的簇） */
  missingAfterCount: number;
  /** 重解是否为精确最优（false = 启发式） */
  exact: boolean;
}

export interface ResilienceInput {
  /** 本次审计的逐簇结果（candidates / assigned 均为 validFonts 下标） */
  clusters: ClusterAudit[];
  validFonts: ParsedFont[];
  /** 每个有效字体在用户原始字体列表中的偏好位次 */
  preferences: number[];
  /** 当前最优回退链（validFonts 下标，已按偏好排序） */
  baselineChain: number[];
  /** 与基线求解一致的链长权重 */
  lengthPriority: number;
}

/**
 * 逐个模拟基线链上每种字体失效并重新求解。
 * 结果按「新增缺失簇数」降序排列（平手时按原承接簇数、偏好位次）。
 */
export function analyzeResilience(input: ResilienceInput): FontFailureResult[] {
  const { clusters, validFonts, preferences, baselineChain, lengthPriority } = input;
  const baselineSet = new Set(baselineChain);

  const scenarios = baselineChain.map((failed) => {
    // ---- 幸存字体：局部下标 <-> 原始下标映射（输出一律映射回原始下标） ----
    const survivors = validFonts.map((_, i) => i).filter((i) => i !== failed);
    const localOf = new Map<number, number>();
    survivors.forEach((orig, local) => localOf.set(orig, local));
    const survivorFonts = survivors.map((orig) => validFonts[orig]);

    // ---- 在幸存字体上重建去重需求模式（模式内为幸存局部下标） ----
    const patternMap = new Map<string, number[]>();
    for (const c of clusters) {
      if (c.free) continue;
      const cands = c.candidates
        .filter((f) => f !== failed)
        .map((f) => localOf.get(f)!);
      const key = cands.join(',');
      if (!patternMap.has(key)) patternMap.set(key, cands);
    }

    // 偏好位次仍传原始 order：保持原始偏好顺序，仅字体数量变化
    const sol = solveFallbackChain({
      fontCount: survivors.length,
      preference: survivors.map((orig) => preferences[orig]),
      patterns: [...patternMap.values()],
      lengthPriority,
    });
    // 求解器按偏好排序输出；局部下标立即还原为原始下标
    const selectedOrig = sol.selected.map((local) => survivors[local]);

    // ---- 逐簇比较失效前后承接结果 ----
    const newMissing: MissingClusterRef[] = [];
    const takeoverMap = new Map<number, ResilienceClusterRef[]>();
    const otherReassignments: ReassignmentRef[] = [];
    const counts = new Map<number, number>();
    let missingAfterCount = 0;

    for (const c of clusters) {
      if (c.free) continue;
      const cands = c.candidates.filter((f) => f !== failed);
      const after = selectedOrig.find((f) => cands.includes(f)) ?? null;

      if (after === null) {
        missingAfterCount += 1;
        // 仅基线可渲染（assigned !== null）的簇才算「新增」缺失
        if (c.assigned !== null) {
          newMissing.push({
            index: c.index,
            text: c.text,
            missingCodepoints: findMissingCodepoints(c.required, survivorFonts),
          });
        }
        continue;
      }

      counts.set(after, (counts.get(after) ?? 0) + 1);
      const ref: ResilienceClusterRef = { index: c.index, text: c.text };
      if (c.assigned === failed) {
        const arr = takeoverMap.get(after);
        if (arr) arr.push(ref);
        else takeoverMap.set(after, [ref]);
      } else if (c.assigned !== null && c.assigned !== after) {
        otherReassignments.push({
          ...ref,
          fromFontIndex: c.assigned,
          toFontIndex: after,
        });
      }
    }

    const takenOver: TakeoverEntry[] = [...takeoverMap.entries()]
      .map(([fontIndex, cls]) => ({
        fontIndex,
        name: validFonts[fontIndex].name,
        preference: preferences[fontIndex],
        clusterCount: cls.length,
        clusters: cls,
      }))
      .sort(
        (a, b) =>
          b.clusterCount - a.clusterCount || a.preference - b.preference,
      );

    const baselineAssigned = clusters.filter(
      (c) => !c.free && c.assigned === failed,
    ).length;

    const replacementChain: ReplacementChainEntry[] = selectedOrig.map((orig) => ({
      fontIndex: orig,
      name: validFonts[orig].name,
      preference: preferences[orig],
      newlyJoined: !baselineSet.has(orig),
      assignedClusters: counts.get(orig) ?? 0,
    }));

    return {
      failedFontIndex: failed,
      name: validFonts[failed].name,
      preference: preferences[failed],
      baselineAssigned,
      newMissingCount: newMissing.length,
      newMissing,
      takenOver,
      otherReassignments,
      replacementChain,
      chainLengthBefore: baselineChain.length,
      chainLengthAfter: selectedOrig.length,
      chainLengthDelta: selectedOrig.length - baselineChain.length,
      missingAfterCount,
      exact: sol.exact,
    } satisfies FontFailureResult;
  });

  // 风险排序：新增缺失降序 → 原承接簇数降序 → 偏好位次升序
  return scenarios.sort(
    (a, b) =>
      b.newMissingCount - a.newMissingCount ||
      b.baselineAssigned - a.baselineAssigned ||
      a.preference - b.preference,
  );
}

// ---- 韧性分析 JSON 导出 ----

export interface ChainLike {
  fontIndex: number;
  name: string;
  preference: number;
  assignedClusters: number;
}

export interface ResilienceReportOptions {
  lengthPriority: number;
  ignoreFormatCodepoints: boolean;
  useMeasuredCoverage: boolean;
  generatedAt: string;
}

const refOf = (c: ResilienceClusterRef) => ({ index: c.index, text: c.text });

/** 构造可下载的韧性分析报告对象（字体名称全部经原始下标回查） */
export function buildResilienceReport(
  results: FontFailureResult[],
  baselineChain: ChainLike[],
  validFonts: ParsedFont[],
  options: ResilienceReportOptions,
) {
  return {
    tool: 'unicode-font-fallback-audit',
    report: 'single-font-failure-resilience',
    version: 1,
    generatedAt: options.generatedAt,
    input: {
      options: {
        lengthPriority: options.lengthPriority,
        ignoreFormatCodepoints: options.ignoreFormatCodepoints,
        useMeasuredCoverage: options.useMeasuredCoverage,
      },
      baselineChain: baselineChain.map((e, i) => ({
        order: i + 1,
        font: e.name,
        fontIndex: e.fontIndex,
        preference: e.preference + 1,
        assignedClusters: e.assignedClusters,
      })),
    },
    scenarios: results.map((r) => ({
      failedFont: r.name,
      fontIndex: r.failedFontIndex,
      preference: r.preference + 1,
      baselineAssignedClusters: r.baselineAssigned,
      newMissingCount: r.newMissingCount,
      newMissing: r.newMissing.map((c) => ({
        ...refOf(c),
        missingCodepoints: c.missingCodepoints.map(formatCodepoint),
      })),
      takenOverByOtherFonts: r.takenOver.map((t) => ({
        font: t.name,
        fontIndex: t.fontIndex,
        preference: t.preference + 1,
        clusterCount: t.clusterCount,
        clusters: t.clusters.map(refOf),
      })),
      otherReassignments: r.otherReassignments.map((c) => ({
        ...refOf(c),
        fromFont: validFonts[c.fromFontIndex].name,
        toFont: validFonts[c.toFontIndex].name,
      })),
      replacementChain: r.replacementChain.map((e, i) => ({
        order: i + 1,
        font: e.name,
        fontIndex: e.fontIndex,
        preference: e.preference + 1,
        newlyJoined: e.newlyJoined,
        assignedClusters: e.assignedClusters,
      })),
      chainLengthBefore: r.chainLengthBefore,
      chainLengthAfter: r.chainLengthAfter,
      chainLengthDelta: r.chainLengthDelta,
      missingAfterCount: r.missingAfterCount,
      solverExact: r.exact,
    })),
  };
}
