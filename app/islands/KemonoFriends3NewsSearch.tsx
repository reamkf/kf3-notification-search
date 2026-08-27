import { useEffect, useMemo, useRef, useState } from "hono/jsx";
import * as v from "valibot";
import { newsArraySchema, News, summarizeValidationIssues } from "../schema";
import { QueryParser } from "../query-parser";
import { normalizeQuery } from "../query-normalizer";
import { getJapaneseDate } from "../get-japanese-date";
import {
  NEWS_DATA_VERSION_HEADER,
  parseNewsResponseHeaders,
  type NewsResponseMetadata,
} from "../news-response-metadata";

// localStorageのキー(同一ドメインでの競合回避のためアプリ固有のprefixを付与)
const STORAGE_KEYS = {
  isSearchVisible: "kf3notif:isSearchVisible",
} as const;

export const INITIAL_LOADING_INDICATOR_ID = "initial-loading-indicator";

const hideInitialLoadingIndicator = () => {
  document.getElementById(INITIAL_LOADING_INDICATOR_ID)?.setAttribute("hidden", "");
};

const NEWS_PAGE_SIZE = 20;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const REFRESH_STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_REFRESH_ATTEMPTS = 3;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const REFRESH_TIMEOUT_MS = 15_000;
const REFRESH_COOLDOWN_MS = 5 * 60_000;
const SEARCH_OPTIONS_TRANSITION_MS = 300;
const METADATA_TEXT_CLASS = "text-sm font-normal leading-5 text-gray-600";

const CATEGORY_LABEL_CLASSES: Record<string, string> = {
  おしらせ: "bg-orange-200 text-orange-900",
  しょうたい: "bg-[#00ac8e]/30 text-[#006b58]",
  イベント: "bg-[#ea5420]/30 text-[#9a3412]",
  キャンペーン: "bg-yellow-200 text-yellow-900",
  スペシャル: "bg-blue-200 text-blue-900",
  メンテナンス: "bg-purple-200 text-purple-900",
  不具合: "bg-gray-300 text-gray-900",
  重要: "bg-red-200 text-red-900",
  アプリ: "bg-green-200 text-green-900",
};

const FALLBACK_CATEGORY_LABEL_CLASSES = [
  "bg-slate-200 text-slate-900",
  "bg-lime-200 text-lime-900",
  "bg-teal-200 text-teal-900",
  "bg-indigo-200 text-indigo-900",
] as const;

const getCategoryLabels = (category?: string): string[] =>
  category
    ?.split(",")
    .map((label) => label.trim())
    .filter(Boolean)
    .map((label) => (label === "【サイト】アプリ" ? "アプリ" : label)) ?? [];

const getCategoryLabelClass = (label: string, index: number): string =>
  CATEGORY_LABEL_CLASSES[label] ??
  FALLBACK_CATEGORY_LABEL_CLASSES[index % FALLBACK_CATEGORY_LABEL_CLASSES.length];

type NewsPayload = {
  data: Array<News>;
  metadata: NewsResponseMetadata;
};

type InitialLoadStatus = "loading" | "success" | "error";

type RefreshState =
  | { status: "idle" }
  | { status: "refreshing" }
  | { status: "error" }
  | { status: "cooldown"; retryAt: number };

type RefreshMetadata = {
  source: "merged";
  fetchedAt: string;
};

type RefreshResponse =
  | { news: Array<News>; metadata: RefreshMetadata }
  | { changed: false; metadata: RefreshMetadata };

const refreshMetadataSchema = v.object({
  source: v.literal("merged"),
  fetchedAt: v.pipe(
    v.string(),
    v.check((value) => Number.isFinite(Date.parse(value)), "fetchedAt must be a timestamp"),
  ),
});

const refreshResponseSchema = v.union([
  v.object({ news: newsArraySchema, metadata: refreshMetadataSchema }),
  v.object({ changed: v.literal(false), metadata: refreshMetadataSchema }),
]);

type RefreshStatusIconProps = {
  status: RefreshState["status"];
};

const RefreshStatusIcon = ({ status }: RefreshStatusIconProps) => {
  if (status === "refreshing") {
    return (
      <span
        aria-hidden="true"
        class="h-4 w-4 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600"
      />
    );
  }

  if (status === "error") {
    return (
      <svg
        aria-hidden="true"
        class="h-5 w-5 text-red-600"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          d="M6 6l12 12M18 6L6 18"
        />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      class="h-5 w-5 text-green-600"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m5 12 4 4L19 6" />
    </svg>
  );
};

const ReloadIcon = () => (
  <svg aria-hidden="true" class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4m-4 4a8 8 0 0 0 14.9 3M20 19v-4h-4"
    />
  </svg>
);

// "yyyy年MM月dd日 HH時mm分ss秒"形式の日付をパース
const parseDateString = (dateString: string): number => {
  const regex = /^(\d{4})年(\d{2})月(\d{2})日 (\d{2})時(\d{2})分(\d{2})秒$/;
  const match = dateString.match(regex);
  if (!match) throw new Error("Invalid date format");
  const [, year, month, day, hours, minutes, seconds] = match;
  return (
    Date.UTC(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hours),
      parseInt(minutes),
      parseInt(seconds),
    ) - JST_OFFSET_MS
  );
};

const newsDateTimestamps = new WeakMap<News, { value: string; timestamp: number }>();

const getNewsTimestamp = (news: News) => {
  const cached = newsDateTimestamps.get(news);
  if (cached?.value === news.newsDate) return cached.timestamp;
  const timestamp = parseDateString(news.newsDate);
  newsDateTimestamps.set(news, { value: news.newsDate, timestamp });
  return timestamp;
};

const formatRelativeFetchedAt = (fetchedAt: string | null, now = Date.now()) => {
  const fetchedAtMs = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  if (!Number.isFinite(fetchedAtMs)) return "不明";

  const elapsedMs = Math.max(0, now - fetchedAtMs);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  if (elapsedSeconds < 60) return `${elapsedSeconds}秒前`;

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}分前`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}時間前`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `${elapsedDays}日前`;

  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return `${elapsedMonths}か月前`;

  return `${Math.floor(elapsedMonths / 12)}年前`;
};

const getRefreshCooldownUntil = (fetchedAt: string | null, now = Date.now()) => {
  const fetchedAtMs = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  return Number.isFinite(fetchedAtMs)
    ? fetchedAtMs + REFRESH_COOLDOWN_MS
    : now + REFRESH_COOLDOWN_MS;
};

const isRefreshNeeded = (metadata: NewsResponseMetadata) => {
  if (metadata.source === "archive-snapshot" || metadata.source === "archive-fallback") return true;
  const fetchedAtMs = metadata.fetchedAt ? Date.parse(metadata.fetchedAt) : Number.NaN;
  if (!Number.isFinite(fetchedAtMs)) return true;
  return Date.now() - fetchedAtMs >= REFRESH_STALE_AFTER_MS;
};

const parseRetryAfterMs = (value: string | null, now = Date.now()) => {
  if (!value) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : DEFAULT_RETRY_AFTER_MS;
};

const parseCooldownMs = async (response: Response) => {
  const headerDelay = response.headers.get("Retry-After");
  if (headerDelay) return parseRetryAfterMs(headerDelay);

  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return DEFAULT_RETRY_AFTER_MS;
    const candidate = body as Record<string, unknown>;
    for (const key of ["nextAvailableAt", "cooldownUntil"]) {
      const value = candidate[key];
      if (typeof value !== "string") continue;
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
    }
    for (const key of ["cooldownSeconds", "retryAfter"]) {
      const seconds = candidate[key];
      if (typeof seconds === "number" && Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
      }
      if (typeof seconds === "string" && seconds.trim() !== "") {
        const parsed = Number(seconds);
        if (Number.isFinite(parsed)) return Math.max(0, parsed * 1000);
      }
    }
  } catch {
    return DEFAULT_RETRY_AFTER_MS;
  }
  return DEFAULT_RETRY_AFTER_MS;
};

// お知らせデータをキーワードでフィルター
const filterNewsByKeyword = (newsArray: Array<News>, query: string) => {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return newsArray;

  try {
    const parser = new QueryParser(normalizedQuery);
    let evaluator;
    try {
      evaluator = parser.parse();
    } catch (error) {
      console.error("Query parsing error:", error);
      return [];
    }
    return newsArray.filter((news) => {
      const normalizedTitle = normalizeQuery(news.title);
      return evaluator(normalizedTitle);
    });
  } catch (error) {
    console.error("Query parsing error:", error);
    // 評価処理の例外時は単純な部分一致検索にフォールバック
    return newsArray.filter((news) => {
      const normalizedTitle = normalizeQuery(news.title);
      return normalizedTitle.includes(normalizedQuery);
    });
  }
};

// 日付によるフィルター
const filterNewsByDate = (newsArray: Array<News>, start: string, end: string) => {
  const startTime = start ? Date.parse(`${start}T00:00:00+09:00`) : -Infinity;
  const endTime = end ? Date.parse(`${end}T00:00:00+09:00`) : Infinity;

  return newsArray.filter((news) => {
    const newsDate = getNewsTimestamp(news);
    return newsDate >= startTime && newsDate < endTime + 86400000;
  });
};

// お知らせデータをソート
const getSortedNews = (data: Array<News>, sortOrder: string) => {
  return [...data].sort((a, b) => {
    const aDate = getNewsTimestamp(a);
    const bDate = getNewsTimestamp(b);
    return sortOrder === "asc" ? aDate - bDate : bDate - aDate;
  });
};

// お知らせデータの検索・表示コンポーネント
const KemonoFriends3NewsSearch = () => {
  const [initialLoadStatus, setInitialLoadStatus] = useState<InitialLoadStatus>("loading");
  const [initialErrorMessage, setInitialErrorMessage] = useState<string | null>(null);
  const [newsPayload, setNewsPayload] = useState<NewsPayload | null>(null);
  const [refreshState, setRefreshState] = useState<RefreshState>({ status: "idle" });
  const [relativeNow, setRelativeNow] = useState(() => Date.now());
  const [searchKeyword, setSearchKeyword] = useState("");
  const [appliedSearchKeyword, setAppliedSearchKeyword] = useState("");
  const [visibleNewsCount, setVisibleNewsCount] = useState(NEWS_PAGE_SIZE);
  const [sortOrder, setSortOrder] = useState("desc");
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [isSearchOptionsRendered, setIsSearchOptionsRendered] = useState(false);
  const [startDate, setStartDate] = useState("2019-09-24");
  const [endDate, setEndDate] = useState("");
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshStateRef = useRef<RefreshState | null>({ status: "idle" });
  const refreshNewsRef = useRef<((attempt?: number, bypassCooldown?: boolean) => void) | null>(
    () => undefined,
  );

  const updateRefreshState = (next: RefreshState) => {
    refreshStateRef.current = next;
    setRefreshState(next);
  };

  const cancelAutoRefresh = () => {
    if (autoRefreshTimerRef.current === null) return;
    clearTimeout(autoRefreshTimerRef.current);
    autoRefreshTimerRef.current = null;
  };

  const refreshNews = (initialAttempt = 0, bypassCooldown = false) => {
    cancelAutoRefresh();
    if (!mountedRef.current || refreshInFlightRef.current || !newsPayload) return;
    const currentRefreshState = refreshStateRef.current;
    if (
      !bypassCooldown &&
      currentRefreshState?.status === "cooldown" &&
      currentRefreshState.retryAt > Date.now()
    ) {
      return;
    }

    const generation = (generationRef.current ?? 0) + 1;
    generationRef.current = generation;
    refreshInFlightRef.current = true;
    updateRefreshState({ status: "refreshing" });

    const finishWithError = () => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      refreshInFlightRef.current = false;
      updateRefreshState({ status: "error" });
    };

    const execute = async (attempt: number): Promise<void> => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
      refreshAbortRef.current = controller;
      try {
        const response = await fetch("/api/kf3-news/refresh", {
          method: "POST",
          ...(newsPayload.metadata.dataVersion
            ? { headers: { [NEWS_DATA_VERSION_HEADER]: newsPayload.metadata.dataVersion } }
            : {}),
          signal: controller.signal,
        });
        if (!mountedRef.current || generationRef.current !== generation) return;

        if (response.status === 202) {
          if (attempt + 1 >= MAX_REFRESH_ATTEMPTS) {
            finishWithError();
            return;
          }
          const delay = parseRetryAfterMs(response.headers.get("Retry-After"));
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            void execute(attempt + 1);
          }, delay);
          return;
        }

        if (response.status === 429) {
          const cooldownMs = await parseCooldownMs(response);
          if (!mountedRef.current || generationRef.current !== generation) return;
          refreshInFlightRef.current = false;
          updateRefreshState({ status: "cooldown", retryAt: Date.now() + cooldownMs });
          return;
        }

        if (!response.ok) {
          finishWithError();
          return;
        }

        const payload: unknown = await response.json();
        if (!mountedRef.current || generationRef.current !== generation) return;
        const result = v.safeParse(refreshResponseSchema, payload);
        if (!result.success) {
          console.error("Refresh data validation failed", summarizeValidationIssues(result.issues));
          finishWithError();
          return;
        }

        const validated: RefreshResponse = result.output;
        const metadata: NewsResponseMetadata = {
          source: validated.metadata.source,
          fetchedAt: validated.metadata.fetchedAt,
          dataVersion: parseNewsResponseHeaders(response.headers).dataVersion,
        };
        if ("changed" in validated) {
          setNewsPayload((previous) => (previous ? { ...previous, metadata } : previous));
        } else {
          setNewsPayload({ data: validated.news, metadata });
        }
        const refreshedAt = Date.now();
        setRelativeNow(refreshedAt);
        refreshInFlightRef.current = false;
        updateRefreshState({
          status: "cooldown",
          retryAt:
            Math.max(refreshedAt, Date.parse(validated.metadata.fetchedAt)) + REFRESH_COOLDOWN_MS,
        });
      } catch (error) {
        if (!mountedRef.current) return;
        if (controller.signal.aborted) {
          finishWithError();
          return;
        }
        console.error("Failed to refresh news data:", error);
        finishWithError();
      } finally {
        clearTimeout(timeout);
        if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
      }
    };

    void execute(initialAttempt);
  };

  refreshNewsRef.current = refreshNews;

  useEffect(() => {
    setEndDate(getJapaneseDate());
  }, []);

  // コンポーネント初回レンダリング時にお知らせデータを取得
  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    const generation = (generationRef.current ?? 0) + 1;
    generationRef.current = generation;
    const loadNews = async () => {
      try {
        const response = await fetch("/api/kf3-news", { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const metadata = parseNewsResponseHeaders(response.headers);
        const data: unknown = await response.json();
        const result = v.safeParse(newsArraySchema, data);
        if (!result.success) {
          console.error("Data validation failed", summarizeValidationIssues(result.issues));
          throw new Error("news data validation failed");
        }
        if (!mountedRef.current || generationRef.current !== generation) return;

        hideInitialLoadingIndicator();
        // 検索欄の表示状態を設定
        const savedSearchVisibility = localStorage.getItem(STORAGE_KEYS.isSearchVisible);
        if (savedSearchVisibility) setIsSearchVisible(savedSearchVisibility === "true");
        setNewsPayload({ data: result.output, metadata });
        setInitialErrorMessage(null);
        setInitialLoadStatus("success");
        updateRefreshState({
          status: "cooldown",
          retryAt: getRefreshCooldownUntil(metadata.fetchedAt),
        });

        if (isRefreshNeeded(metadata)) {
          autoRefreshTimerRef.current = setTimeout(() => {
            autoRefreshTimerRef.current = null;
            refreshNewsRef.current?.(0, true);
          }, 50);
        }
      } catch (error) {
        if (controller.signal.aborted || !mountedRef.current) return;
        hideInitialLoadingIndicator();
        console.error("Failed to fetch news data:", error);
        setInitialErrorMessage("データの取得に失敗しました。\n時間を空けて再度お試しください。");
        setInitialLoadStatus("error");
      }
    };

    void loadNews();
    return () => {
      mountedRef.current = false;
      generationRef.current = (generationRef.current ?? 0) + 1;
      controller.abort();
      refreshAbortRef.current?.abort();
      cancelAutoRefresh();
      if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (isSearchVisible) {
      setIsSearchOptionsRendered(true);
      return;
    }
    if (!isSearchOptionsRendered) return;

    const timer = setTimeout(() => {
      setIsSearchOptionsRendered(false);
    }, SEARCH_OPTIONS_TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [isSearchVisible, isSearchOptionsRendered]);

  useEffect(() => {
    if (!newsPayload?.metadata.fetchedAt && refreshState.status !== "cooldown") return;
    let interval: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
    };
    const start = () => {
      if (document.visibilityState === "hidden" || interval !== null) return;
      interval = setInterval(() => setRelativeNow(Date.now()), 1_000);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") stop();
      else {
        setRelativeNow(Date.now());
        start();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    start();
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stop();
    };
  }, [newsPayload?.metadata.fetchedAt, refreshState.status]);

  useEffect(() => {
    if (refreshState.status !== "cooldown" || refreshState.retryAt > relativeNow) return;
    updateRefreshState({ status: "idle" });
  }, [relativeNow, refreshState]);

  // 検索キーワードの変更をハンドリング
  const handleSearchChange = (event: Event) => {
    if (event.target instanceof HTMLInputElement) setSearchKeyword(event.target.value);
  };

  // Enterキーが押されたときにキーワード検索を実行
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.key !== "Enter") return;
    handleSearch();
  };

  // 検索を実行する関数
  const handleSearch = () => {
    setAppliedSearchKeyword(searchKeyword);
    setVisibleNewsCount(NEWS_PAGE_SIZE);
  };

  // 日付の変更をハンドリング
  const handleStartDateChange = (event: Event) => {
    if (event.target instanceof HTMLInputElement) {
      setStartDate(event.target.value);
      setVisibleNewsCount(NEWS_PAGE_SIZE);
    }
  };

  const handleEndDateChange = (event: Event) => {
    if (event.target instanceof HTMLInputElement) {
      setEndDate(event.target.value);
      setVisibleNewsCount(NEWS_PAGE_SIZE);
    }
  };

  // ソート順を変更する
  const handleSortOrderChange = (event: Event) => {
    if (event.target instanceof HTMLSelectElement) {
      setSortOrder(event.target.value);
      setVisibleNewsCount(NEWS_PAGE_SIZE);
    }
  };

  // 検索欄の表示・非表示を切り替える
  const toggleSearchVisibility = () => {
    setIsSearchVisible((previous) => {
      const next = !previous;
      localStorage.setItem(STORAGE_KEYS.isSearchVisible, next.toString());
      return next;
    });
  };

  const newsItems = newsPayload?.data;
  const filteredNews = useMemo(() => {
    if (!newsItems) return [];
    const keywordFilteredNews = filterNewsByKeyword(newsItems, appliedSearchKeyword);
    const dateFilteredNews = filterNewsByDate(keywordFilteredNews, startDate, endDate);
    return getSortedNews(dateFilteredNews, sortOrder);
  }, [newsItems, appliedSearchKeyword, startDate, endDate, sortOrder]);

  const newsData = useMemo(
    () => filteredNews.slice(0, visibleNewsCount),
    [filteredNews, visibleNewsCount],
  );
  const numberOfNews = filteredNews.length;
  const totalNewsCount = newsPayload?.data.length ?? 0;
  const isKeywordSearchApplied = normalizeQuery(appliedSearchKeyword).length > 0;
  const hasMoreNews = visibleNewsCount < numberOfNews;
  const isInitialLoading = initialLoadStatus === "loading";
  const isRefreshing = refreshState.status === "refreshing";
  const isCooldownActive = refreshState.status === "cooldown" && refreshState.retryAt > relativeNow;
  const isRefreshDisabled = isInitialLoading || isRefreshing || isCooldownActive;

  useEffect(() => {
    const loadMoreTarget = loadMoreRef.current;
    if (!loadMoreTarget || !hasMoreNews) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisibleNewsCount((currentCount) =>
          Math.min(currentCount + NEWS_PAGE_SIZE, numberOfNews),
        );
      },
      { rootMargin: "200px" },
    );

    observer.observe(loadMoreTarget);
    return () => observer.disconnect();
  }, [hasMoreNews, numberOfNews, visibleNewsCount]);

  const metadata = newsPayload?.metadata ?? null;
  const lastFetchedText = formatRelativeFetchedAt(metadata?.fetchedAt ?? null, relativeNow);
  const refreshStatusMessage =
    refreshState.status === "refreshing"
      ? "お知らせを再取得しています"
      : refreshState.status === "error"
        ? "お知らせの再取得に失敗しました"
        : refreshState.status === "cooldown" && isCooldownActive
          ? "お知らせは再取得待機中です"
          : "";
  const refreshButtonClasses = isRefreshDisabled
    ? "text-gray-400"
    : "text-gray-700 hover:text-gray-900";
  return (
    <div>
      {initialErrorMessage && (
        <div
          class="bg-red-100 text-red-700 px-4 py-3 rounded-lg relative flex items-center justify-center"
          role="alert"
        >
          <svg
            class="w-6 h-6 mr-2 text-red-700 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M18.364 5.636l-12.728 12.728M5.636 5.636l12.728 12.728"
            />
          </svg>
          <span class="block sm:inline">{initialErrorMessage}</span>
        </div>
      )}

      {newsPayload?.metadata.source === "archive-fallback" && (
        <div class="mb-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p role="status" aria-live="polite" aria-atomic="true">
            公式データを利用できなかったため、保存済みアーカイブを表示しています。
          </p>
        </div>
      )}

      <div class={`space-y-2 ${isInitialLoading || !newsPayload ? "hidden" : ""}`}>
        <button
          type="button"
          onClick={toggleSearchVisibility}
          aria-expanded={isSearchVisible ? "true" : "false"}
          aria-controls="news-search-options"
          class={`w-full md:w-auto px-6 py-3 text-white font-medium rounded-lg transition-colors duration-200 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-2 ${
            isSearchVisible ? "bg-gray-500 hover:bg-gray-600" : "bg-blue-500 hover:bg-blue-600"
          }`}
        >
          <svg
            class={`w-5 h-5 transition-transform duration-200 ${isSearchVisible ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
          </svg>
          検索オプション
        </button>

        <div
          id="news-search-options"
          aria-hidden={isSearchVisible ? "false" : "true"}
          class={`transition-all duration-300 ease-in-out overflow-hidden ${
            isSearchVisible ? "max-h-screen opacity-100" : "max-h-0 opacity-0"
          }`}
        >
          {isSearchOptionsRendered && (
            <div class="bg-white p-1 rounded-lg space-y-3">
              <div class="flex flex-wrap items-center gap-4">
                <div class="flex items-center gap-2">
                  <label
                    class="text-sm font-medium text-gray-700 whitespace-nowrap"
                    for="sortOrder"
                  >
                    ソート順:
                  </label>
                  <div className="relative">
                    <select
                      id="sortOrder"
                      value={sortOrder}
                      onChange={handleSortOrderChange}
                      className="w-full pl-4 pr-8 py-2 bg-white border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 appearance-none"
                    >
                      <option value="desc">新しい順</option>
                      <option value="asc">古い順</option>
                    </select>
                    <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                      <svg
                        className="w-5 h-5 text-gray-500"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M19 9l-7 7-7-7"
                        />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700" for="news-keyword">
                  キーワード検索:
                </label>
                <div className="flex flex-wrap gap-2">
                  <input
                    type="text"
                    id="news-keyword"
                    className="flex-1 min-w-[200px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="(測定 or 掃除) 開催 -予告"
                    value={searchKeyword}
                    onChange={handleSearchChange}
                    onKeyDown={handleKeyDown}
                  />
                  <button
                    type="button"
                    onClick={handleSearch}
                    className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-medium rounded-lg transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-2"
                  >
                    検索
                  </button>
                </div>
              </div>

              <div class="space-y-2">
                <span class="block text-sm font-medium text-gray-700">期間:</span>
                <div class="flex flex-wrap items-center gap-2">
                  <label for="startDate" class="sr-only">
                    開始日
                  </label>
                  <input
                    type="date"
                    id="startDate"
                    value={startDate}
                    onChange={handleStartDateChange}
                    class="px-4 py-2 bg-white border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 appearance-none"
                  />
                  <span class="text-gray-500" aria-hidden="true">
                    ～
                  </span>
                  <label for="endDate" class="sr-only">
                    終了日
                  </label>
                  <input
                    type="date"
                    id="endDate"
                    value={endDate}
                    onChange={handleEndDateChange}
                    class="px-4 py-2 bg-white border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 appearance-none"
                  />
                </div>
              </div>
            </div>
          )}
          {isSearchOptionsRendered && <div class="border-t border-gray-300 mt-4 mb-2"></div>}
        </div>

        <div class="flex items-center gap-3 mt-0">
          {isKeywordSearchApplied && (
            <span class={METADATA_TEXT_CLASS}>検索結果: {numberOfNews}件</span>
          )}
          {metadata && (
            <div class="ml-auto flex items-center gap-1.5">
              <span
                data-testid="news-metadata"
                data-refresh-status={refreshState.status}
                aria-busy={isRefreshing ? "true" : "false"}
                class="inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <RefreshStatusIcon status={refreshState.status} />
                <span class={METADATA_TEXT_CLASS}>
                  最終取得:{" "}
                  {metadata.fetchedAt ? (
                    <time dateTime={metadata.fetchedAt}>{lastFetchedText}</time>
                  ) : (
                    lastFetchedText
                  )}
                  {" ･ "}
                  {totalNewsCount}件
                </span>
              </span>
              <button
                type="button"
                data-testid="news-refresh-button"
                onClick={() => refreshNewsRef.current?.()}
                disabled={isRefreshDisabled}
                aria-label="お知らせを再取得"
                aria-describedby="news-refresh-status"
                title="お知らせを再取得"
                class={`inline-flex min-h-7 cursor-pointer items-center justify-center rounded p-1 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed ${refreshButtonClasses}`}
              >
                <ReloadIcon />
              </button>
            </div>
          )}
          <span
            id="news-refresh-status"
            class="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {refreshStatusMessage}
          </span>
        </div>

        <ul class="space-y-4">
          {newsData.map((news) => (
            <li
              key={news.targetUrl}
              class="group bg-white hover:bg-blue-50 border border-gray-300 rounded-lg transition-all duration-200 hover:shadow-lg"
            >
              <a
                href={`https://kemono-friends-3.jp${news.targetUrl}`}
                target="_blank"
                rel="noreferrer"
                class="block p-4"
              >
                <div class="flex flex-wrap items-center gap-2 mb-2">
                  <time class="text-sm text-gray-500">{news.newsDate.slice(0, 11)}</time>
                  {getCategoryLabels(news.category).map((categoryLabel, categoryIndex) => (
                    <span
                      class={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getCategoryLabelClass(categoryLabel, categoryIndex)}`}
                      data-testid="news-category"
                      key={`${categoryLabel}-${categoryIndex}`}
                    >
                      <span class="sr-only">分類: </span>
                      {categoryLabel}
                    </span>
                  ))}
                </div>
                <p class="text-gray-800 group-hover:text-blue-600 transition-colors duration-200">
                  {news.title}
                </p>
              </a>
            </li>
          ))}
        </ul>

        {hasMoreNews && (
          <div ref={loadMoreRef} class="flex justify-center py-4" role="status">
            <span class="text-sm text-gray-500">お知らせを読み込んでいます...</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default KemonoFriends3NewsSearch;
