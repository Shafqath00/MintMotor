const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
admin.initializeApp({
    projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "jellylabsprojects",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "jellylabsprojects.firebasestorage.app",
});

const database = admin.firestore();
database.settings({
    databaseId: "mintmotor"
});
const storageStatusDatabase = getFirestore(admin.app(), "(default)");

const storage = admin.storage();

module.exports = {admin, database, storage, storageStatusDatabase};
