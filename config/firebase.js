// config/firebase.js
import dotenv from "dotenv";
dotenv.config();

import admin from "firebase-admin";

const bucketName = process.env.STORAGE_BUCKET;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
    ...(bucketName ? { storageBucket: bucketName } : {}),
  });
}

export const auth = admin.auth();
export const db = admin.firestore();
export const bucket = bucketName ? admin.storage().bucket() : null;
export { admin };
