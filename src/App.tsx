import { useCallback, useEffect, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { supabase } from "./lib/supabase";
import { subscribeToSchemaChanges } from "./lib/realtime";

/* ------------------------------------------------------------------ */
/*  Core engine configuration                                          */
/* ------------------------------------------------------------------ */
const CORE_VERSION = "0.12.10";

/*
 * IMPORTANT FIX: @ffmpeg/ffmpeg 0.12.x creates a MODULE web worker.
 * The module worker cannot use importScripts() and needs the ESM build
 * (dist/esm) of ffmpeg-core which exports `default createFFmpegCore`.
 * The old code used dist/umd -> ffmpeg.load() always threw
 * "import failed". We also list several CDNs and fall back in order.
 */
const CDNS = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://fastly.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
];

/* ------------------------------------------------------------------ */
/*  Supported formats                                                 */
/* ------------------------------------------------------------------ */
const VIDEO_EXTS = new Set([
  "mp4",
  "webm",
  "mov",
  "mkv",
  "avi",
  "wmv",
  "m4v",
  "flv",
  "3gp",
  "ts",
  "mts",
  "m2ts",
  "ogv",
  "mpeg",
  "mpg",
]);

const AUDIO_EXTS = new Set([
  "mp3",
  "m4a",
  "wav",
  "ogg",
  "oga",
  "opus",
  "aac",
  "flac",
  "wma",
]);

const ALL_EXTS = new Set([...VIDEO_EXTS, ...AUDIO_EXTS]);

const getExt = (name: string) => {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
};

const NOTES = ["🎵", "🎶", "♪", "♫", "🎼", "♬", "♩", "🎶"];

type OutputFormat = "mp3" | "mp4";
type EngineState = "loading" | "ready" | "error";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
async function fetchBlobWithProgress(
  url: string,
  mime: string,
  onProgress?: (pct: number) => void
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;

  if (!res.body || !total) {
    const blob = await res.blob();
    return URL.createObjectURL(new Blob([blob], { type: mime }));
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(Math.min(99, Math.round((received / total) * 100)));
  }

  return URL.createObjectURL(new Blob(chunks as BlobPart[], { type: mime }));
}

/* ------------------------------------------------------------------ */
/*  Logo                                                               */
/* ------------------------------------------------------------------ */
function Logo({ size = 84 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="شعار نغم"
    >
      <defs>
        <linearGradient id="naghamLogo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="0.55" stopColor="#9333ea" />
          <stop offset="1" stopColor="#db2777" />
        </linearGradient>
        <linearGradient id="naghamShine" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(255,255,255,0.4)" />
          <stop offset="1" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="61" height="61" rx="17" fill="url(#naghamLogo)" />
      <rect x="1.5" y="1.5" width="61" height="61" rx="17" fill="url(#naghamShine)" />
      <path
        d="M25 48V19l23-6v27"
        stroke="#fff"
        strokeWidth="5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="19.5" cy="48" r="6.5" fill="#fff" />
      <circle cx="42.5" cy="40" r="6.5" fill="#fff" />
      <path
        d="M10 30c0-8 6-13 14-14"
        stroke="#fff"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        opacity="0.85"
      />
      <path
        d="M10 40c2-6 6-10 12-12"
        stroke="#fff"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
        opacity="0.5"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */
function App() {
  const [engine, setEngine] = useState<EngineState>("loading");
  const [loadStatus, setLoadStatus] = useState("جارٍ تجهيز محرك التحويل...");
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [isVideoFile, setIsVideoFile] = useState(false);

  const [format, setFormat] = useState<OutputFormat>("mp3");
  const [bitrate, setBitrate] = useState(192);

  const [isConverting, setIsConverting] = useState(false);
  const [convertProgress, setConvertProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState("");
  const [resultName, setResultName] = useState("");
  const [resultFormat, setResultFormat] = useState<OutputFormat>("mp3");

  const ffmpegRef = useRef<FFmpeg | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadingRef = useRef(false);
  const loadGenRef = useRef(0);
  const realProgressRef = useRef(0);
  const doneRef = useRef(false);
  const convertTimerRef = useRef<number | null>(null);
  const logRef = useRef<string[]>([]);

  useEffect(() => {
    const channel = subscribeToSchemaChanges((payload) => {
      console.log("[نغم] Change received!", payload);
    });
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const loadFFmpeg = useCallback(async () => {
    const gen = ++loadGenRef.current;
    setEngine("loading");
    setLoadError("");
    setLoadProgress(0);

    const isStale = () => gen !== loadGenRef.current;

    let lastError: unknown = null;

    for (let i = 0; i < CDNS.length; i++) {
      if (isStale()) return;
      const ffmpeg = new FFmpeg();
      ffmpegRef.current = ffmpeg;

      ffmpeg.on("log", ({ message }) => {
        logRef.current.push(message);
        if (logRef.current.length > 80) logRef.current.shift();
      });
      ffmpeg.on("progress", ({ progress }) => {
        realProgressRef.current = Math.max(
          realProgressRef.current,
          Math.round((progress || 0) * 100)
        );
        setConvertProgress((p) => Math.max(p, realProgressRef.current));
      });

      const base = CDNS[i];
      try {
        setLoadStatus(
          i === 0
            ? "جارٍ تنزيل محرك التحويل... (مرة واحدة فقط، ثم يُحفظ في المتصفح)"
            : `المحاولة من خادم بديل (${i + 1}/${CDNS.length})...`
        );
        setLoadProgress(2);

        const coreURL = await fetchBlobWithProgress(
          `${base}/ffmpeg-core.js`,
          "text/javascript",
          (p) => setLoadProgress(2 + p * 5)
        );

        setLoadStatus(
          "جارٍ تنزيل محرك التحويل (حوالي 30 ميجابايت، مرة واحدة فقط)..."
        );
        const wasmURL = await fetchBlobWithProgress(
          `${base}/ffmpeg-core.wasm`,
          "application/wasm",
          (p) => setLoadProgress(8 + p * 87)
        );

        setLoadStatus("جارٍ تهيئة محرك التحويل...");
        setLoadProgress(95);
        await ffmpeg.load({ coreURL, wasmURL });

        if (isStale()) return;
        setLoadProgress(100);
        setLoadStatus("المحرك جاهز");
        setEngine("ready");
        return;
      } catch (error) {
        lastError = error;
        console.error(`CDN failed (${base}):`, error);
        try {
          ffmpeg.terminate();
        } catch {
          /* noop */
        }
      }
    }

    if (isStale()) return;
    setEngine("error");
    setLoadError(
      lastError instanceof Error
        ? lastError.message
        : "تعذر الاتصال بخوادم التحميل. تحقق من الإنترنت وأعد المحاولة."
    );
  }, []);

  useEffect(() => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    loadFFmpeg().finally(() => {
      loadingRef.current = false;
    });
    return () => {
      loadingRef.current = false;
      loadGenRef.current++;
      try {
        ffmpegRef.current?.terminate();
      } catch {
        /* noop */
      }
    };
  }, [loadFFmpeg]);

  const retryLoad = () => {
    setLoadError("");
    setLoadProgress(0);
    setEngine("loading");
    try {
      ffmpegRef.current?.terminate();
    } catch {
      /* noop */
    }
    loadFFmpeg();
  };

  const acceptFile = (f: File) => {
    const ext = getExt(f.name);
    if (!ALL_EXTS.has(ext)) {
      alert(
        "هذه الصيغة غير مدعومة. الصيغ المدعومة: MP4, MP3, WebM, MOV, MKV, AVI, WAV, M4A وغيرها."
      );
      return;
    }
    const isVideo = f.type.startsWith("video/") || VIDEO_EXTS.has(ext);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setFile(f);
    setIsVideoFile(isVideo);
    setPreviewUrl(URL.createObjectURL(f));
    setResultUrl("");
    setResultName("");
    setConvertProgress(0);
    realProgressRef.current = 0;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) acceptFile(f);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer.files?.[0];
    if (f) acceptFile(f);
  };

  const startFakeProgress = () => {
    setConvertProgress(0);
    realProgressRef.current = 0;
    doneRef.current = false;
    convertTimerRef.current = window.setInterval(() => {
      if (doneRef.current) return;
      setConvertProgress((p) => {
        const next = Math.min(88, p + Math.max(0.3, (100 - p) / 45));
        return Math.max(next, realProgressRef.current);
      });
    }, 250);
  };

  const convert = async () => {
    if (!file) {
      alert("الرجاء اختيار ملف أولاً");
      return;
    }
    if (engine !== "ready") {
      alert("الرجاء الانتظار حتى يكتمل تحميل المحرك...");
      return;
    }

    setIsConverting(true);
    setResultUrl("");
    setResultName("");
    startFakeProgress();

    try {
      const ffmpeg = ffmpegRef.current;
      if (!ffmpeg) throw new Error("المحرك غير جاهز");
      logRef.current = [];

      const inExt = getExt(file.name);
      const inFile = `input.${inExt || "bin"}`;
      const outExt = format;
      const outFile = `output.${outExt}`;

      await ffmpeg.writeFile(inFile, await fetchFile(file));

      let args: string[];
      if (format === "mp3") {
        args = [
          "-i",
          inFile,
          "-vn",
          "-acodec",
          "libmp3lame",
          "-b:a",
          `${bitrate}k`,
          "-ar",
          "44100",
          "-y",
          outFile,
        ];
      } else if (isVideoFile) {
        // Video -> MP4: instant remux (lossless copy) when possible
        args = ["-i", inFile, "-c", "copy", "-movflags", "+faststart", "-y", outFile];
      } else {
        // Audio -> MP4 (AAC inside MP4 container)
        args = ["-i", inFile, "-vn", "-c:a", "aac", "-b:a", "192k", "-y", outFile];
      }

      let code = await ffmpeg.exec(args);

      if (code !== 0 && format === "mp4" && isVideoFile) {
        // Fallback: keep video stream, re-encode audio to AAC
        code = await ffmpeg.exec([
          "-i",
          inFile,
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-movflags",
          "+faststart",
          "-y",
          outFile,
        ]);
      }

      if (code !== 0) {
        const tail = logRef.current
          .slice(-4)
          .join(" ")
          .slice(0, 400);
        throw new Error(`فشل التحويل. ${tail}`);
      }

      doneRef.current = true;
      setConvertProgress(96);

      const data = await ffmpeg.readFile(outFile);
      const mime = format === "mp3" ? "audio/mpeg" : "video/mp4";
      const url = URL.createObjectURL(
        new Blob([data as BlobPart], { type: mime })
      );
      setResultUrl(url);
      setResultFormat(format);
      setResultName(`${file.name.replace(/\.[^/.]+$/, "")}.${format}`);
      setConvertProgress(100);

      try {
        await ffmpeg.deleteFile(inFile);
        await ffmpeg.deleteFile(outFile);
      } catch {
        /* noop */
      }
    } catch (error) {
      console.error("Conversion error:", error);
      alert(error instanceof Error ? error.message : "حدث خطأ أثناء التحويل.");
    } finally {
      if (convertTimerRef.current !== null) {
        clearInterval(convertTimerRef.current);
        convertTimerRef.current = null;
      }
      setIsConverting(false);
    }
  };

  const download = () => {
    if (!resultUrl || !resultName) return;
    const a = document.createElement("a");
    a.href = resultUrl;
    a.download = resultName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const reset = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setFile(null);
    setPreviewUrl("");
    setIsVideoFile(false);
    setResultUrl("");
    setResultName("");
    setConvertProgress(0);
    realProgressRef.current = 0;
    if (inputRef.current) inputRef.current.value = "";
  };

  /* ================================================================ */
  return (
    <div
      dir="rtl"
      className="relative min-h-screen text-white overflow-x-hidden"
      style={{ fontFamily: "'Tajawal','Segoe UI',Tahoma,sans-serif" }}
    >
      {/* ------------ Animated background ------------ */}
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <div className="anim-gradient" />
        <div className="blob blob-a" />
        <div className="blob blob-b" />
        <div className="blob blob-c" />
        {NOTES.map((n, i) => (
          <span
            key={i}
            className="note"
            style={{
              left: `${(i * 12.5 + 5) % 95}%`,
              fontSize: `${24 + (i % 3) * 8}px`,
              animationDelay: `${i * 1.2}s`,
              animationDuration: `${9 + (i % 4) * 2}s`,
            }}
          >
            {n}
          </span>
        ))}
      </div>

      <div className="relative z-10 max-w-5xl mx-auto px-4 py-8 md:py-12">
        {/* ---------------- Header ---------------- */}
        <header className="text-center mb-10">
          <div className="logo-wrap mx-auto mb-6">
            <Logo />
          </div>
          <h1 className="text-5xl md:text-6xl font-black mb-3 drop-shadow-2xl">
            نغم <span className="brand-gradient">NAGHAM</span>
          </h1>
          <p className="text-2xl md:text-3xl font-bold mb-2">
            حوّل فيديوهاتك وملفاتك الصوتية إلى MP3 و MP4
          </p>
          <p className="text-base md:text-lg opacity-90">
            تحويل سريع وآمن 100% — كل شيء يتم داخل متصفحك بدون رفع أي ملف
          </p>
        </header>

        {/* ---------------- Engine status ---------------- */}
        {engine === "loading" && (
          <div className="mb-6 bg-white/95 backdrop-blur rounded-2xl p-5 shadow-xl">
            <div className="flex items-center gap-3 mb-3">
              <span className="animate-spin rounded-full h-7 w-7 border-4 border-indigo-500 border-t-transparent" />
              <p className="font-bold text-slate-800">{loadStatus}</p>
              <span className="ms-auto text-2xl font-black text-indigo-600">
                {Math.round(loadProgress)}%
              </span>
            </div>
            <div className="h-3 w-full rounded-full bg-slate-200 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 transition-all duration-200"
                style={{ width: `${Math.round(loadProgress)}%` }}
              />
            </div>
            <p className="mt-3 text-sm text-slate-500">
              يُحمَّل المحرك مرة واحدة فقط، وبعدها يُحفظ في المتصفح ليكون التحويل
              فورياً في المرات القادمة.
            </p>
          </div>
        )}

        {engine === "ready" && (
          <div className="mb-6 bg-emerald-50/95 backdrop-blur border-2 border-emerald-500 rounded-2xl p-5 flex items-center gap-4 shadow-xl">
            <span className="text-4xl">✅</span>
            <div>
              <p className="font-black text-emerald-800 text-lg">
                المحرك جاهز للتحويل!
              </p>
              <p className="text-sm text-emerald-600">
                FFmpeg Engine Ready — اختر ملفاً وابدأ التحويل الآن
              </p>
            </div>
          </div>
        )}

        {engine === "error" && (
          <div className="mb-6 bg-red-50/95 backdrop-blur border-2 border-red-500 rounded-2xl p-5 shadow-xl">
            <p className="font-black text-red-800 text-lg mb-1">
              ❌ تعذر تحميل المحرك
            </p>
            <p className="text-sm text-red-600 mb-2">{loadError}</p>
            <p className="text-xs text-red-500 mb-4">
              تأكد من اتصالك بالإنترنت، أو افتح الموقع عبر خادم محلي
              (npm run dev أو npm start).
            </p>
            <button
              onClick={retryLoad}
              className="bg-red-500 text-white px-6 py-2.5 rounded-xl font-bold hover:bg-red-600 transition-colors"
            >
              🔄 إعادة المحاولة
            </button>
          </div>
        )}

        {/* ---------------- Converter card ---------------- */}
        <section className="bg-white/90 backdrop-blur-xl rounded-3xl shadow-2xl p-6 md:p-10 text-slate-800 mb-8">
          {!file ? (
            <div
              onDrop={handleDrop}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={() => inputRef.current?.click()}
              className="border-4 border-dashed border-purple-300 rounded-2xl p-12 md:p-16 text-center cursor-pointer bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50 transition-all hover:border-purple-500 hover:scale-[1.02]"
            >
              <input
                ref={inputRef}
                type="file"
                accept="video/*,audio/*,.mp4,.mp3"
                onChange={handleFileChange}
                className="hidden"
              />
              <div className="text-8xl mb-6 animate-bounce">🎵</div>
              <p className="text-3xl font-black mb-4">اختر ملف فيديو أو صوت</p>
              <p className="text-lg text-slate-600 mb-8">
                اضغط هنا أو اسحب الملف إلى هذه المنطقة
              </p>
              <div className="inline-block">
                <div className="bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 text-white px-12 py-5 rounded-full font-bold text-xl hover:shadow-2xl transition-all hover:scale-110 shadow-lg">
                  📂 اختيار الملف
                </div>
              </div>
              <p className="text-sm text-slate-500 mt-8">
                MP4, MP3, WebM, MOV, MKV, AVI, WAV, M4A, FLAC وغيرها
              </p>
            </div>
          ) : (
            <div>
              {/* File preview */}
              <div className="mb-6">
                <h3 className="text-2xl font-black mb-4 flex items-center gap-3">
                  <span className="text-3xl">📹</span>
                  <span>الملف المختار</span>
                </h3>
                <div className="bg-slate-900 rounded-2xl overflow-hidden shadow-2xl">
                  {isVideoFile ? (
                    <video
                      src={previewUrl}
                      controls
                      className="w-full max-h-96"
                    />
                  ) : (
                    <audio
                      src={previewUrl}
                      controls
                      className="w-full p-6"
                      preload="metadata"
                    />
                  )}
                </div>
                <div className="mt-3 bg-indigo-50 rounded-xl p-4 flex flex-wrap gap-x-6 gap-y-1 text-sm font-semibold text-slate-700 shadow">
                  <span>📄 {file.name}</span>
                  <span>💾 {(file.size / 1048576).toFixed(2)} ميجابايت</span>
                  <span>
                    {isVideoFile ? "🎬 ملف فيديو" : "🔊 ملف صوتي"}
                  </span>
                </div>
              </div>

              {/* Format + quality */}
              <div className="mb-6">
                <p className="font-black mb-3 text-lg">صيغة الإخراج</p>
                <div className="flex gap-3 flex-wrap">
                  <button
                    onClick={() => setFormat("mp3")}
                    className={`px-8 py-4 rounded-2xl font-black text-lg transition-all border-2 shadow ${
                      format === "mp3"
                        ? "bg-gradient-to-r from-indigo-600 to-purple-600 text-white border-transparent scale-105"
                        : "bg-white text-slate-600 border-slate-300 hover:border-indigo-400"
                    }`}
                  >
                    🎵 MP3 <span className="text-sm font-bold">(صوت فقط)</span>
                  </button>
                  <button
                    onClick={() => setFormat("mp4")}
                    className={`px-8 py-4 rounded-2xl font-black text-lg transition-all border-2 shadow ${
                      format === "mp4"
                        ? "bg-gradient-to-r from-pink-600 to-rose-600 text-white border-transparent scale-105"
                        : "bg-white text-slate-600 border-slate-300 hover:border-pink-400"
                    }`}
                  >
                    🎬 MP4 <span className="text-sm font-bold">(فيديو)</span>
                  </button>
                </div>

                {format === "mp3" && (
                  <div className="mt-5">
                    <p className="font-black mb-2">جودة الصوت (Bitrate)</p>
                    <select
                      value={bitrate}
                      onChange={(e) => setBitrate(Number(e.target.value))}
                      disabled={isConverting}
                      className="w-full md:w-72 px-4 py-3 rounded-xl border-2 border-slate-300 bg-white font-bold text-slate-800 focus:border-indigo-500 focus:outline-none"
                    >
                      <option value={128}>128 كيلوبت/ثانية</option>
                      <option value={192}>192 كيلوبت/ثانية (موصى به)</option>
                      <option value={256}>256 كيلوبت/ثانية</option>
                      <option value={320}>320 كيلوبت/ثانية (أعلى جودة)</option>
                    </select>
                  </div>
                )}

                {format === "mp4" && isVideoFile && (
                  <p className="mt-4 text-sm text-slate-500">
                    ⚡ تحويل MP4 يتم بنسخ الصوت والفيديو مباشرة بدون فقدان الجودة
                    وبسرعة عالية جداً.
                  </p>
                )}
              </div>

              {/* Convert / Progress */}
              {!resultUrl && (
                <div className="flex gap-4 justify-center flex-wrap mb-6">
                  <button
                    onClick={convert}
                    disabled={isConverting || engine !== "ready"}
                    className="bg-gradient-to-r from-green-500 to-emerald-600 text-white px-14 py-5 rounded-full font-black text-2xl hover:shadow-2xl transition-all hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:scale-100 shadow-lg"
                  >
                    {isConverting ? (
                      <span className="flex items-center gap-4">
                        <span className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-white border-t-transparent" />
                        <span>جاري التحويل... {Math.round(convertProgress)}%</span>
                      </span>
                    ) : engine !== "ready" ? (
                      <span>⏳ انتظر تحميل المحرك...</span>
                    ) : (
                      <span>
                        🎵 تحويل إلى {format.toUpperCase()}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={reset}
                    disabled={isConverting}
                    className="bg-gradient-to-r from-slate-500 to-slate-600 text-white px-10 py-5 rounded-full font-bold text-2xl hover:shadow-2xl transition-all disabled:opacity-50 shadow-lg"
                  >
                    ❌ إلغاء
                  </button>
                </div>
              )}

              {isConverting && (
                <div className="mb-6">
                  <div className="w-full bg-slate-200 rounded-full h-8 overflow-hidden shadow-inner">
                    <div
                      className="bg-gradient-to-r from-green-400 via-blue-500 to-purple-600 h-full rounded-full flex items-center justify-center text-white text-lg font-black transition-all duration-300 shadow-lg"
                      style={{ width: `${Math.round(convertProgress)}%` }}
                    >
                      {convertProgress > 6 && `${Math.round(convertProgress)}%`}
                    </div>
                  </div>
                  <p className="text-center text-lg font-bold mt-3 text-slate-600">
                    🔄 جارٍ التحويل... انتظر قليلاً
                  </p>
                </div>
              )}

              {/* Result */}
              {resultUrl && (
                <div className="bg-gradient-to-br from-green-50 via-emerald-50 to-teal-50 border-4 border-green-500 rounded-3xl p-8 text-center shadow-2xl">
                  <div className="text-7xl mb-4">🎉</div>
                  <h3 className="text-3xl font-black text-green-700 mb-2">
                    تم التحويل بنجاح!
                  </h3>
                  <p className="text-slate-600 font-semibold mb-6">
                    جاهز للتحميل — {resultName}
                  </p>

                  <div className="bg-white rounded-2xl p-6 mb-6 shadow-xl">
                    <p className="font-black mb-3 text-slate-700">
                      {resultFormat === "mp3" ? "🎧 استمع للنتيجة:" : "🎬 شاهد النتيجة:"}
                    </p>
                    {resultFormat === "mp3" ? (
                      <audio src={resultUrl} controls className="w-full h-14" />
                    ) : (
                      <video src={resultUrl} controls className="w-full max-h-96 rounded-xl" />
                    )}
                  </div>

                  <div className="flex gap-5 justify-center flex-wrap">
                    <button
                      onClick={download}
                      className="bg-gradient-to-r from-blue-600 to-blue-800 text-white px-12 py-5 rounded-full font-black text-2xl hover:shadow-2xl transition-all hover:scale-105 flex items-center gap-3 shadow-lg"
                    >
                      <span className="text-2xl">⬇️</span>
                      <span>تحميل {resultFormat.toUpperCase()}</span>
                    </button>
                    <button
                      onClick={reset}
                      className="bg-gradient-to-r from-purple-600 to-pink-600 text-white px-12 py-5 rounded-full font-black text-2xl hover:shadow-2xl transition-all hover:scale-105 shadow-lg"
                    >
                      ➕ تحويل ملف آخر
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ---------------- Features ---------------- */}
        <div className="grid md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white/90 backdrop-blur rounded-2xl p-8 text-center shadow-xl hover:scale-105 transition-all">
            <div className="text-6xl mb-4">⚡</div>
            <h4 className="font-black text-2xl mb-2">سرعة فائقة</h4>
            <p className="text-slate-600">محرك FFmpeg داخل متصفحك مباشرة</p>
          </div>
          <div className="bg-white/90 backdrop-blur rounded-2xl p-8 text-center shadow-xl hover:scale-105 transition-all">
            <div className="text-6xl mb-4">🔒</div>
            <h4 className="font-black text-2xl mb-2">خصوصية كاملة</h4>
            <p className="text-slate-600">ملفاتك لا تغادر جهازك أبداً</p>
          </div>
          <div className="bg-white/90 backdrop-blur rounded-2xl p-8 text-center shadow-xl hover:scale-105 transition-all">
            <div className="text-6xl mb-4">🎚️</div>
            <h4 className="font-black text-2xl mb-2">جودة عالية</h4>
            <p className="text-slate-600">MP3 حتى 320 كيلوبت + MP4 بدون فقدان</p>
          </div>
        </div>

        {/* ---------------- Footer ---------------- */}
        <footer className="text-center text-sm opacity-90">
          <p className="font-bold text-lg">
            🎵 نغم NAGHAM — محول فوري، مجاني للأبد
          </p>
          <p className="mt-1 opacity-80">
            Powered by React + FFmpeg.wasm · المرة الأولى فقط تحتاج تنزيل المحرك
          </p>
        </footer>
      </div>
    </div>
  );
}

export default App;
