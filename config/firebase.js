
/* config/firebase.js */
import "dotenv/config";

import {
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const bucketName = process.env.STORAGE_BUCKET;

function normalizePrivateKey(value) {
  if (!value) {
    throw new Error("FIREBASE_PRIVATE_KEY is not set");
  }

  let key = String(value).trim();

  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }

  key = key
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  if (
    !key.includes("-----BEGIN PRIVATE KEY-----") ||
    !key.includes("-----END PRIVATE KEY-----")
  ) {
    throw new Error(
      "FIREBASE_PRIVATE_KEY is not a valid PEM private key"
    );
  }

  return key;
}

if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID is not set");
}

if (!clientEmail) {
  throw new Error("FIREBASE_CLIENT_EMAIL is not set");
}

const privateKey = normalizePrivateKey(
  process.env.FIREBASE_PRIVATE_KEY
);

const app =
  getApps().find((existing) => existing.name === "[DEFAULT]") ??
  initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey,
    }),
    ...(bucketName ? { storageBucket: bucketName } : {}),
  });

export const auth = getAuth(app);

export const db = getFirestore(app);

export const bucket = bucketName
  ? getStorage(app).bucket()
  : null;
