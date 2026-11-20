-- 第一輪 SQLite 結構，擷取自 2fe4890 的 server/db.ts。
PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS teachers(name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, google TEXT);
CREATE TABLE IF NOT EXISTS activities(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES teachers(name), title TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL, phase TEXT NOT NULL DEFAULT '準備中', source TEXT, ready INTEGER NOT NULL DEFAULT 0, import_revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS groups_(id TEXT PRIMARY KEY, aid TEXT NOT NULL REFERENCES activities(id), leader TEXT NOT NULL,
  label TEXT NOT NULL, joincode TEXT NOT NULL, UNIQUE(aid,id), UNIQUE(aid,leader), UNIQUE(aid,label), UNIQUE(aid,joincode));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, teacher TEXT REFERENCES teachers(name), aid TEXT REFERENCES activities(id),
  gid TEXT, isleader INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL, FOREIGN KEY(aid,gid) REFERENCES groups_(aid,id));
CREATE TABLE IF NOT EXISTS questions(aid TEXT NOT NULL REFERENCES activities(id), q TEXT NOT NULL, label TEXT NOT NULL,
  stem TEXT NOT NULL, pos INTEGER NOT NULL, targets TEXT NOT NULL, winner TEXT, published INTEGER NOT NULL DEFAULT 0, published_at INTEGER,
  progress TEXT NOT NULL DEFAULT '待寫入', preview TEXT, consent TEXT, PRIMARY KEY(aid,q));
CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE TABLE IF NOT EXISTS submissions(aid TEXT NOT NULL, q TEXT NOT NULL, gid TEXT NOT NULL, answer TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE REFERENCES inbox(seq), rank INTEGER NOT NULL, PRIMARY KEY(aid,q,gid), UNIQUE(aid,q,rank),
  FOREIGN KEY(aid,q) REFERENCES questions(aid,q), FOREIGN KEY(aid,gid) REFERENCES groups_(aid,id));
CREATE TABLE IF NOT EXISTS marks(book TEXT, tab INTEGER, cell TEXT, job TEXT NOT NULL, version INTEGER NOT NULL,
  PRIMARY KEY(book,tab,cell));
CREATE TABLE IF NOT EXISTS oauth(state TEXT PRIMARY KEY, teacher TEXT REFERENCES teachers(name), expires INTEGER);
CREATE TABLE IF NOT EXISTS fixture_books(book TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
