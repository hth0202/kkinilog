import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';

const app = initializeApp({
  apiKey: 'AIzaSyBY_c_z6l6uY8GY_ehbRDF9LJ4hXMIoH6s',
  authDomain: 'kkinilog.firebaseapp.com',
  projectId: 'kkinilog',
  storageBucket: 'kkinilog.firebasestorage.app',
  messagingSenderId: '945942920504',
  appId: '1:945942920504:web:7f2ea690d1e95038ed15cd',
});

export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();

// 로컬 테스트: VITE_FIREBASE_EMULATOR=1 npm run dev 로 띄우면 Firebase 에뮬레이터에 연결한다.
if (import.meta.env.DEV && import.meta.env.VITE_FIREBASE_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
