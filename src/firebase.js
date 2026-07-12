import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyA4oEkq9ZGItg5L1DpW69p2OyeGbbNMkmM",
  authDomain: "puraza22-c779e.firebaseapp.com",
  projectId: "puraza22-c779e",
  storageBucket: "puraza22-c779e.firebasestorage.app",
  messagingSenderId: "670427094308",
  appId: "1:670427094308:web:7c653ef9ee8b9c67f167b1",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
