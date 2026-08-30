import { memo } from "hono/jsx";
import type { News } from "../schema";

const CATEGORY_LABEL_CLASSES = new Map<string, string>([
  ["おしらせ", "bg-orange-200 text-orange-900"],
  ["しょうたい", "bg-[#00ac8e]/30 text-[#006b58]"],
  ["イベント", "bg-[#ea5420]/30 text-[#9a3412]"],
  ["キャンペーン", "bg-yellow-200 text-yellow-900"],
  ["スペシャル", "bg-blue-200 text-blue-900"],
  ["メンテナンス", "bg-purple-200 text-purple-900"],
  ["不具合", "bg-gray-300 text-gray-900"],
  ["重要", "bg-red-200 text-red-900"],
  ["アプリ", "bg-green-200 text-green-900"],
]);

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
  CATEGORY_LABEL_CLASSES.get(label) ??
  FALLBACK_CATEGORY_LABEL_CLASSES[index % FALLBACK_CATEGORY_LABEL_CLASSES.length];

type NewsRowProps = {
  news: News;
  onRender?: () => void;
};

export const NewsRow = memo(({ news, onRender }: NewsRowProps) => {
  onRender?.();
  return (
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
  );
});
