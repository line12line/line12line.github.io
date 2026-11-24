// Підключення сайту «12 лінія» до Firebase (база, вхід, фото).
// Сторінка звертається до бази через window.claude.use(...) — тут цей інтерфейс реалізовано на Firebase.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, onSnapshot, collection, getDocs, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth, onAuthStateChanged, signInAnonymously, GoogleAuthProvider, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { CONFIG } from "./config.js";

const app = initializeApp(CONFIG.firebase);
const fs = getFirestore(app);
const auth = getAuth(app);
const OWNERS = (CONFIG.owners || []).map(e => String(e).trim().toLowerCase());

const strip = o => JSON.parse(JSON.stringify(o));
const wrap = s => ({ id: s.id, exists: s.exists(), data: () => (s.exists() ? s.data() : undefined) });

// Перший стан входу: якщо людина не входила — тихо отримуємо анонімний ідентифікатор браузера.
const firstUser = new Promise(resolve => {
  const stop = onAuthStateChanged(auth, async u => {
    if (u) { stop(); resolve(u); return; }
    try { await signInAnonymously(auth); } catch (e) { console.warn("anon sign-in failed", e); stop(); resolve(null); }
  });
});

const isGoogle = u => !!u && !u.isAnonymous && !!u.email;
const isOwnerUser = u => isGoogle(u) && OWNERS.includes(u.email.toLowerCase());

const db = {
  doc: p => {
    const r = doc(fs, p);
    return {
      get: async () => wrap(await getDoc(r)),
      set: v => setDoc(r, strip(v)),
      onSnapshot: (cb, err) => onSnapshot(r, s => cb(wrap(s)), err),
    };
  },
  collection: p => ({
    onSnapshot: (cb, err) => onSnapshot(collection(fs, p), q => cb({ docs: q.docs.map(wrap) }), err),
  }),
};

const user = {
  id: async () => { const u = await firstUser; return u ? u.uid : null; },
  isOwner: async () => isOwnerUser(await firstUser),
  canEdit: async () => false,
  profiles: async ids => {
    const out = {};
    await Promise.all((ids || []).map(async id => {
      try { const s = await getDoc(doc(fs, "users", id)); if (s.exists()) out[id] = s.data(); } catch (e) {}
    }));
    return out;
  },
  search: async q => {
    const s = await getDocs(collection(fs, "users"));
    q = String(q || "").toLowerCase();
    return s.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(x => !q || (x.name || "").toLowerCase().includes(q) || (x.email || "").toLowerCase().includes(q))
      .map(x => ({ id: x.id, name: (x.name || "Без імені") + (x.email ? " · " + x.email : "") }));
  },
};

// Фото: кожне фото — окремий документ у колекції photos, у вигляді data-URL.
const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
const assets = {
  upload: async blob => {
    const d = await blobToDataUrl(blob);
    if (d.length > 950000) throw new Error("Фото завелике");
    const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await setDoc(doc(fs, "photos", id), { d, at: Date.now() });
    return { url: "fs:" + id };
  },
};
const photoCache = {};
const photo = async id => {
  if (photoCache[id]) return photoCache[id];
  const s = await getDoc(doc(fs, "photos", id));
  const d = s.exists() ? s.data().d : null;
  if (d) photoCache[id] = d;
  return d;
};

// Вхід і вихід адміністраторів (Google). Викликається прямо з натискання кнопки.
window.fbAuth = {
  signIn: async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      location.reload();
    } catch (e) {
      console.warn(e);
      const code = (e && e.code) || "";
      if (code.includes("popup-closed") || code.includes("cancelled")) return;
      alert("Не вдалося увійти. Якщо ви відкрили сайт із Viber чи Facebook, відкрийте його в Chrome або Safari і спробуйте ще раз.");
    }
  },
  signOut: async () => { await signOut(auth); location.reload(); },
};

async function boot() {
  const u = await firstUser;
  window.fbAuth.email = isGoogle(u) ? u.email : null;
  if (isGoogle(u)) {
    try { await setDoc(doc(fs, "users", u.uid), { name: u.displayName || "", email: u.email, at: Date.now() }); } catch (e) {}
  }
  // Перший вхід власника: переносимо початкові дані сайту в базу.
  if (isOwnerUser(u)) {
    try {
      const c = await getDoc(doc(fs, "site", "content"));
      if (!c.exists()) {
        const seed = await (await fetch("seed.json", { cache: "no-store" })).json();
        const b = writeBatch(fs);
        b.set(doc(fs, "site", "content"), seed.content);
        b.set(doc(fs, "site", "photos"), { map: seed.photos });
        b.set(doc(fs, "site", "admins"), { owner: u.uid, ids: [] });
        await b.commit();
      }
    } catch (e) { console.warn("seed failed", e); }
  }
  document.dispatchEvent(new CustomEvent("fb-auth", { detail: { email: window.fbAuth.email } }));
  return { db, user, assets, photo };
}

boot().then(m => window.__fbResolve(m), e => { console.error(e); window.__fbResolve(null); });
