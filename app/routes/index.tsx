import { createRoute } from "honox/factory";
import KemonoFriends3, { INITIAL_LOADING_INDICATOR_ID } from "../islands/KemonoFriends3NewsSearch";

export default createRoute((c) => {
  const name = "けもフレ３おしらせ検索";
  return c.render(
    <div class="flex flex-col">
      <h1 class="text-4xl font-bold p-4 pb-0">{name}</h1>
      <div class="min-h-screen bg-yellow-400 px-4">
        <div class="max-w-6xl mx-auto bg-white shadow-lg rounded-lg p-6 my-4">
          <div
            id={INITIAL_LOADING_INDICATOR_ID}
            class="flex justify-center items-center p-8"
            role="status"
            aria-live="polite"
          >
            <div class="w-8 h-8 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin" />
            <span class="ml-4 text-gray-600 font-medium">データを取得しています...</span>
          </div>
          <KemonoFriends3 />
        </div>
      </div>
    </div>,
    { title: name },
  );
});
