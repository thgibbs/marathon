import { randomUUID } from "node:crypto";

export type Id = string;

export const newId = (): Id => randomUUID();
