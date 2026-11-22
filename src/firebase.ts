import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

export const ADMIN_BOOTSTRAP_EMAIL = 'ricocesar86@gmail.com';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

export async function signInAdminWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOutAdmin(): Promise<void> {
  await signOut(auth);
}

export function observeAuth(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}

export async function checkIsCurrentUserAdmin(
  user: User | null,
  configAdminEmails?: string[]
): Promise<boolean> {
  if (!user || !user.emailVerified || !user.email) return false;
  const normalizedEmail = user.email.trim().toLowerCase();
  if (normalizedEmail === ADMIN_BOOTSTRAP_EMAIL.toLowerCase()) {
    return true;
  }

  // 1) Check in-memory authorized adminEmails from raffleConfig/main
  if (
    Array.isArray(configAdminEmails) &&
    configAdminEmails.some((e) => String(e).trim().toLowerCase() === normalizedEmail)
  ) {
    return true;
  }

  // 2) Check fresh raffleConfig/main.adminEmails directly from Firestore
  try {
    const cfgSnap = await getDoc(doc(db, 'raffleConfig', 'main'));
    if (cfgSnap.exists()) {
      const list = cfgSnap.data()?.adminEmails;
      if (
        Array.isArray(list) &&
        list.some((e) => String(e).trim().toLowerCase() === normalizedEmail)
      ) {
        return true;
      }
    }
  } catch (error) {
    console.warn('Could not verify adminEmails from raffleConfig/main:', error);
  }

  // 3) Legacy /admins/{uid} fallback
  const adminPath = `admins/${user.uid}`;
  try {
    const snap = await getDoc(doc(db, 'admins', user.uid));
    return snap.exists() && snap.data()?.role === 'admin';
  } catch (error) {
    console.warn('Admin check failed for', adminPath, error);
    return false;
  }
}
