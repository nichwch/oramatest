const {
  create,
  count,
  insert,
  searchVector,
  search,
  removeMultiple,
} = require("@orama/orama");
const getEmbedding = require("./appEmbeddings.cjs");
const fs = require("fs");
const { app } = require("electron");
const log = require("electron-log");

const userDataPath = app.getPath("userData");
const dbPath = `${userDataPath}/.dbfile.msp`;
const lastFetchedDateFile = `${userDataPath}/.lastFetchedDate.txt`;
let db;
let restoreFromFile, persistToFile;
const initDB = async () => {
  //@ts-ignore
  let _ = await import("@orama/plugin-data-persistence/server");
  restoreFromFile = _.restoreFromFile;

  persistToFile = _.persistToFile;
  log.info("initializing database...");
  try {
    db = await restoreFromFile("binary", dbPath);
    log.log("db restored from file");
  } catch {
    log.log("no db file found, creating new db");
    db = await create({
      schema: {
        parent: "string",
        tags: "string[]",
        embedding: "vector[384]",
        content: "string",
      },
      id: "oramadb",
    });
    await persistToFile(db, "binary", dbPath);
  } finally {
    //@ts-ignore
    const dbCount = await count(db);
    log.log(`db has ${dbCount} entries`);
  }
};

const processSegment = async (segment, fileName) => {
  log.log("processing segment");
  segment = segment.trim();
  if (segment.length === 0) return;
  /** @typedef {string[]|null} tags */
  const tags =
    segment.match(/\[\[.*?\]\]/g)?.map((tag) => {
      return tag.replace("[[", "").replace("]]", "");
    }) || [];
  try {
    log.log("attempting to get embedding");
    const embedding = await getEmbedding(segment);
    log.log("got embedding", embedding);
    const entry = {
      parent: fileName,
      tags,
      embedding,
      content: segment,
    };
    await insert(db, entry);
  } catch (e) {
    log.error(e);
  }
};

const indexDirectory = async (directory) => {
  log.log("indexing directory...");
  /** @type {Date} */
  let lastFetchedDate;
  try {
    const lastFetchedDateText = fs.readFileSync(lastFetchedDateFile, "utf8");
    lastFetchedDate = new Date(lastFetchedDateText);
  } catch {
    lastFetchedDate = new Date(0);
  }
  log.log("last fetched date:", lastFetchedDate);
  const files = fs.readdirSync(directory);
  const filesModifiedSinceLastFetch = files.filter((file) => {
    const lastModifiedTime = fs
      .statSync(`${directory}/${file}`)
      .mtime.getTime();
    return lastModifiedTime > lastFetchedDate.getTime();
  });
  log.log("read directory", files, filesModifiedSinceLastFetch);
  const promises = [];
  // for modified files, remove all their entries from the DB first
  for (let file of filesModifiedSinceLastFetch) {
    const filePath = `${directory}/${file}`;
    const rowsForFile = await search(db, {
      term: filePath,
      properties: ["parent"],
    });
    const idsForFile = rowsForFile.hits.map((hit) => hit.id);
    log.log("deleting following rows", rowsForFile);
    await removeMultiple(db, idsForFile);
  }
  // then insert the new entries from the modified files
  for (let file of filesModifiedSinceLastFetch) {
    const filePath = `${directory}/${file}`;
    const file_text = fs.readFileSync(filePath, "utf8");
    log.log("read file", file);
    const segments = file_text?.split("\n") || "";
    for (let segment of segments) {
      promises.push(processSegment(segment, filePath));
    }
  }
  try {
    await Promise.all(promises);
  } catch (e) {
    log.error(e);
  } finally {
    await persistToFile(db, "binary", dbPath);
    fs.writeFileSync(lastFetchedDateFile, new Date().toString());
    const dbCount = await count(db);
    log.log(`db has ${dbCount} entries`);
  }
};

/** @param {string} query */
const queryDB = async (query, similarity = 0.8, limit = 10) => {
  const queryEmbedding = await getEmbedding(query);
  log.log("queryEmbedding", queryEmbedding);
  const results = await searchVector(db, {
    vector: queryEmbedding,
    property: "embedding",
    similarity,
    limit,
  });
  return results;
};
module.exports = { db, initDB, indexDirectory, queryDB };
