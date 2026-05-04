import { createApp } from "./app";
import "./style.css";

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("OpenCAE Core app root was not found.");
}

void createApp(root);
