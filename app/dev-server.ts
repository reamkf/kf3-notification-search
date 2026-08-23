import { createApp } from "honox/server";
import { createNewsApp } from "./server";

export default createApp({ app: createNewsApp({}) });
