import { SqlModel, type SqlDocument } from "./SqlModel.ts";
export interface Counter { _id: string; value: number }
export type CounterDocument = SqlDocument<Counter>;
export default new SqlModel<Counter>("counters", "value");
