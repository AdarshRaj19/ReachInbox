import { elasticsearch } from "./elasticsearch.js";

try {
  const response = await elasticsearch.info();
  console.log("Elasticsearch connected:", response.version.number);
} catch (error) {
  console.error("Elasticsearch connection failed:", error);
  process.exitCode = 1;
} finally {
  await elasticsearch.close();
}