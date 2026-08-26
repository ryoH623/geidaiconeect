import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "../../firebase";
import BookingCalendar from "../../components/booking/BookingCalendar";

type QuickRangeKey = "morning" | "afternoon" | "evening" | "all";
type QuickDateSelectKey = "weekday" | "holiday" | "holidayOnly" | "all";
type LessonMethodMap = Record<string, string[]>;
type WeeklyOverwriteMode = "skip" | "overwrite";

type PerDaySetting = {
  times: string[];
  lessonMethodMap: LessonMethodMap;
};

type PerDaySettingsMap = Record<string, PerDaySetting>;

type RegisteredSummaryMap = Record<
  string,
  {
    slotCount: number;
    lessonMethodLabels: string[];
  }
>;

type ExistingDayDoc = {
  docId: string;
  time: string;
};

type ExistingDayDocMap = Record<string, ExistingDayDoc[]>;

type SavedPattern = {
  id: string;
  name: string;
  times: string[];
  lessonMethodMap: LessonMethodMap;
  createdAt: string;
};

const SCHEDULES_COLLECTION = "schedules";
const SLOT_MINUTES = 30;
const REDIRECT_AFTER_SAVE = false;

const TIME_SLOTS: string[] = [
  "08:00",
  "08:30",
  "09:00",
  "09:30",
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "12:00",
  "12:30",
  "13:00",
  "13:30",
  "14:00",
  "14:30",
  "15:00",
  "15:30",
  "16:00",
  "16:30",
  "17:00",
  "17:30",
  "18:00",
  "18:30",
  "19:00",
  "19:30",
  "20:00",
  "20:30",
  "21:00",
  "21:30",
];

const LESSON_METHODS = ["自宅", "スタジオ", "出張", "オンライン"] as const;

const WEEKDAY_OPTIONS = [
  { value: 1, label: "月曜" },
  { value: 2, label: "火曜" },
  { value: 3, label: "水曜" },
  { value: 4, label: "木曜" },
  { value: 5, label: "金曜" },
  { value: 6, label: "土曜" },
  { value: 0, label: "日曜" },
];

function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDateKey(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function formatDateKeyToSlash(dateKey: string): string {
  if (!dateKey) return "";
  const [y, m, d] = dateKey.split("-");
  if (!y || !m || !d) return dateKey;
  return `${y}/${m}/${d}`;
}

function normalizeSlashDateToHyphen(value: string): string {
  return value.replace(/\//g, "-").trim();
}

function getMonthEnd(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function getMonthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function buildDateKeysInMonth(date: Date): { startKey: string; endKey: string } {
  const start = getMonthStart(date);
  const end = getMonthEnd(date);
  return {
    startKey: formatDateKey(start),
    endKey: formatDateKey(end),
  };
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function buildSlotDocId(teacherId: string, date: string, time: string): string {
  return `${teacherId}_${date}_${time.replace(":", "")}`;
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

function getQuickRangeSlots(range: QuickRangeKey): string[] {
  switch (range) {
    case "morning":
      return TIME_SLOTS.filter((time) => time >= "08:00" && time <= "11:30");
    case "afternoon":
      return TIME_SLOTS.filter((time) => time >= "12:00" && time <= "17:30");
    case "evening":
      return TIME_SLOTS.filter((time) => time >= "18:00" && time <= "21:30");
    case "all":
      return [...TIME_SLOTS];
    default:
      return [];
  }
}

function nthMonday(year: number, month: number, nth: number): number {
  let count = 0;
  for (let day = 1; day <= 31; day += 1) {
    const dt = new Date(year, month - 1, day);
    if (dt.getMonth() + 1 !== month) break;
    if (dt.getDay() === 1) {
      count += 1;
      if (count === nth) return day;
    }
  }
  return -1;
}

function calcShunbun(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function calcShubun(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function isJapaneseHoliday(date: Date): boolean {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const key = formatDateKey(date);

  const fixedHolidaySet = new Set([
    `${y}-01-01`,
    `${y}-02-11`,
    `${y}-02-23`,
    `${y}-04-29`,
    `${y}-05-03`,
    `${y}-05-04`,
    `${y}-05-05`,
    `${y}-08-11`,
    `${y}-11-03`,
    `${y}-11-23`,
  ]);

  if (fixedHolidaySet.has(key)) return true;
  if (m === 1 && d === nthMonday(y, 1, 2)) return true;
  if (m === 7 && d === nthMonday(y, 7, 3)) return true;
  if (m === 9 && d === nthMonday(y, 9, 3)) return true;
  if (m === 10 && d === nthMonday(y, 10, 2)) return true;
  if (m === 3 && d === calcShunbun(y)) return true;
  if (m === 9 && d === calcShubun(y)) return true;

  return false;
}

function isPastDateKey(dateKey: string): boolean {
  const date = parseDateKey(dateKey);
  const today = new Date();
  const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return target < todayOnly;
}

function getSelectableDateKeysInMonth(displayMonth: Date): string[] {
  const end = getMonthEnd(displayMonth);
  const dateKeys: string[] = [];

  for (let day = 1; day <= end.getDate(); day += 1) {
    const date = new Date(displayMonth.getFullYear(), displayMonth.getMonth(), day);
    const key = formatDateKey(date);
    if (!isPastDateKey(key)) {
      dateKeys.push(key);
    }
  }

  return dateKeys;
}

function emptyPerDaySetting(): PerDaySetting {
  return { times: [], lessonMethodMap: {} };
}

function clonePerDaySetting(setting: PerDaySetting): PerDaySetting {
  return {
    times: [...setting.times],
    lessonMethodMap: Object.fromEntries(
      Object.entries(setting.lessonMethodMap).map(([time, methods]) => [time, [...methods]])
    ),
  };
}

function getDateRangeKeys(startKey: string, endKey: string): string[] {
  if (!startKey || !endKey) return [];
  const start = parseDateKey(startKey);
  const end = parseDateKey(endKey);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  if (start > end) return [];

  const dates: string[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  while (cursor <= end) {
    dates.push(formatDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function getFirstAndLastWeekdayInMonth(
  baseMonth: Date,
  weekday: number
): { start: string; end: string } {
  const year = baseMonth.getFullYear();
  const month = baseMonth.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);

  let firstMatch: Date | null = null;
  let lastMatch: Date | null = null;

  for (let day = 1; day <= lastDay.getDate(); day += 1) {
    const current = new Date(year, month, day);
    if (current.getDay() === weekday) {
      if (!firstMatch) firstMatch = current;
      lastMatch = current;
    }
  }

  return {
    start: firstMatch ? formatDateKey(firstMatch) : formatDateKey(firstDay),
    end: lastMatch ? formatDateKey(lastMatch) : formatDateKey(lastDay),
  };
}

function cloneLessonMethodMap(map: LessonMethodMap): LessonMethodMap {
  return Object.fromEntries(
    Object.entries(map).map(([time, methods]) => [time, [...methods]])
  );
}

function buildPatternStorageKey(teacherId: string): string {
  return `schedulePatterns:${teacherId}`;
}

function loadPatternsFromStorage(teacherId: string): SavedPattern[] {
  if (!teacherId) return [];
  try {
    const raw = localStorage.getItem(buildPatternStorageKey(teacherId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedPattern[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function savePatternsToStorage(teacherId: string, patterns: SavedPattern[]) {
  if (!teacherId) return;
  localStorage.setItem(buildPatternStorageKey(teacherId), JSON.stringify(patterns));
}

export default function ScheduleForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [teacherId, setTeacherId] = useState("");
  const [displayMonth, setDisplayMonth] = useState(new Date());

  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [bulkTimes, setBulkTimes] = useState<string[]>([]);
  const [bulkLessonMethodMap, setBulkLessonMethodMap] = useState<LessonMethodMap>({});
  const [perDaySettings, setPerDaySettings] = useState<PerDaySettingsMap>({});

  const [registeredDates, setRegisteredDates] = useState<string[]>([]);
  const [registeredSummaries, setRegisteredSummaries] = useState<RegisteredSummaryMap>({});

  const [copiedDaySourceDate, setCopiedDaySourceDate] = useState("");
  const [copiedDaySetting, setCopiedDaySetting] = useState<PerDaySetting | null>(null);

  const [editingDate, setEditingDate] = useState("");
  const [isLoadingDateDetail, setIsLoadingDateDetail] = useState(false);

  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isLoadingRegisteredDates, setIsLoadingRegisteredDates] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [successMessage, setSuccessMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const [weeklyTemplateWeekday, setWeeklyTemplateWeekday] = useState<number>(1);
  const [weeklyTemplateStartDate, setWeeklyTemplateStartDate] = useState("");
  const [weeklyTemplateEndDate, setWeeklyTemplateEndDate] = useState("");
  const [weeklyTemplateTimes, setWeeklyTemplateTimes] = useState<string[]>([]);
  const [weeklyTemplateLessonMethodMap, setWeeklyTemplateLessonMethodMap] =
    useState<LessonMethodMap>({});
  const [weeklyTemplateOverwriteMode, setWeeklyTemplateOverwriteMode] =
    useState<WeeklyOverwriteMode>("skip");

  const [patternName, setPatternName] = useState("");
  const [savedPatterns, setSavedPatterns] = useState<SavedPattern[]>([]);

  const [isPatternOpen, setIsPatternOpen] = useState(false);
  const [isWeeklyTemplateOpen, setIsWeeklyTemplateOpen] = useState(false);

  useEffect(() => {
    const nextRange = getFirstAndLastWeekdayInMonth(displayMonth, weeklyTemplateWeekday);
    setWeeklyTemplateStartDate(nextRange.start);
    setWeeklyTemplateEndDate(nextRange.end);
  }, [displayMonth, weeklyTemplateWeekday]);

  useEffect(() => {
    if (!teacherId) {
      setSavedPatterns([]);
      return;
    }
    setSavedPatterns(loadPatternsFromStorage(teacherId));
  }, [teacherId]);

  const weeklyTemplatePreviewDates = useMemo(() => {
    const allRangeDates = getDateRangeKeys(weeklyTemplateStartDate, weeklyTemplateEndDate);

    return allRangeDates.filter((dateKey) => {
      if (!selectedDates.includes(dateKey)) return false;
      if (isPastDateKey(dateKey)) return false;

      const date = parseDateKey(dateKey);
      return date.getDay() === weeklyTemplateWeekday;
    });
  }, [
    weeklyTemplateStartDate,
    weeklyTemplateEndDate,
    weeklyTemplateWeekday,
    selectedDates,
  ]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setTeacherId(user?.uid ?? "");
      setIsAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    setPerDaySettings((prev) => {
      const next = { ...prev };
      selectedDates.forEach((date) => {
        if (!next[date]) next[date] = emptyPerDaySetting();
      });
      Object.keys(next).forEach((date) => {
        if (!selectedDates.includes(date)) delete next[date];
      });
      return next;
    });
  }, [selectedDates]);

  const fetchRegisteredDates = useCallback(
    async (monthDate: Date, currentTeacherId?: string) => {
      const uid = currentTeacherId ?? teacherId;
      if (!uid) {
        setRegisteredDates([]);
        setRegisteredSummaries({});
        return;
      }

      setIsLoadingRegisteredDates(true);
      setErrorMessage("");

      try {
        const { startKey, endKey } = buildDateKeysInMonth(monthDate);
        const schedulesRef = collection(db, SCHEDULES_COLLECTION);
        // 等価条件だけで取得し、月の絞り込みはメモリ上で行う。
        // 等価条件に範囲条件（date >= / <=）を混ぜると複合インデックスが必要になり、
        // このプロジェクトは firestore.indexes.json を管理していないため必ず失敗する。
        const q = query(schedulesRef, where("teacherId", "==", uid));

        const snapshot = await getDocs(q);
        const docsInMonth = snapshot.docs.filter((docSnap) => {
          const date = docSnap.data()?.date;
          return typeof date === "string" && date >= startKey && date <= endKey;
        });

        const dates = docsInMonth
          .map((docSnap) => docSnap.data()?.date)
          .filter((date): date is string => typeof date === "string");

        setRegisteredDates(uniqueSorted(dates));

        const summaryMap: RegisteredSummaryMap = {};
        docsInMonth.forEach((docSnap) => {
          const data = docSnap.data();
          const date = typeof data.date === "string" ? data.date : "";
          const lessonMethods = Array.isArray(data.lessonMethods)
            ? data.lessonMethods.filter((v): v is string => typeof v === "string")
            : [];

          if (!date) return;

          if (!summaryMap[date]) {
            summaryMap[date] = { slotCount: 0, lessonMethodLabels: [] };
          }

          summaryMap[date].slotCount += 1;
          summaryMap[date].lessonMethodLabels = uniqueSorted([
            ...summaryMap[date].lessonMethodLabels,
            ...lessonMethods,
          ]);
        });

        setRegisteredSummaries(summaryMap);
      } catch (error) {
        console.error(error);
        setErrorMessage("登録済み日付の取得に失敗しました。");
      } finally {
        setIsLoadingRegisteredDates(false);
      }
    },
    [teacherId]
  );

  useEffect(() => {
    if (!isAuthLoading && teacherId) {
      void fetchRegisteredDates(displayMonth, teacherId);
    }
  }, [displayMonth, fetchRegisteredDates, isAuthLoading, teacherId]);

  const buildExistingDayDocMap = async (dates: string[]): Promise<ExistingDayDocMap> => {
    const result: ExistingDayDocMap = {};
    if (!teacherId || dates.length === 0) return result;

    for (const date of dates) {
      const q = query(
        collection(db, SCHEDULES_COLLECTION),
        where("teacherId", "==", teacherId),
        where("date", "==", date)
      );
      const snapshot = await getDocs(q);

      result[date] = snapshot.docs
        .map((docSnap): ExistingDayDoc => {
          const data = docSnap.data();
          return {
            docId: docSnap.id,
            time: typeof data.time === "string" ? data.time : "",
          };
        })
        .filter((item) => item.time !== "");
    }

    return result;
  };

  const loadExistingScheduleForDate = useCallback(
    async (dateKey: string) => {
      if (!teacherId) return;

      setIsLoadingDateDetail(true);
      setErrorMessage("");
      setSuccessMessage("");

      try {
        const q = query(
          collection(db, SCHEDULES_COLLECTION),
          where("teacherId", "==", teacherId),
          where("date", "==", dateKey)
        );

        const snapshot = await getDocs(q);
        const times: string[] = [];
        const methodMap: LessonMethodMap = {};

        snapshot.docs.forEach((docSnap) => {
          const data = docSnap.data();
          const time = typeof data.time === "string" ? data.time : "";
          const lessonMethods = Array.isArray(data.lessonMethods)
            ? data.lessonMethods.filter((v): v is string => typeof v === "string")
            : [];

          if (!time) return;
          times.push(time);
          methodMap[time] = lessonMethods;
        });

        setSelectedDates([dateKey]);
        setPerDaySettings({
          [dateKey]: {
            times: uniqueSorted(times),
            lessonMethodMap: methodMap,
          },
        });
        setEditingDate(dateKey);
        setSuccessMessage(`${dateKey} の既存スケジュールを読み込みました。`);
      } catch (error) {
        console.error(error);
        setErrorMessage("既存スケジュールの読み込みに失敗しました。");
      } finally {
        setIsLoadingDateDetail(false);
      }
    },
    [teacherId]
  );

  useEffect(() => {
    const editDate = searchParams.get("editDate");
    if (!teacherId || !editDate) return;
    setDisplayMonth(parseDateKey(editDate));
    void loadExistingScheduleForDate(editDate);
  }, [teacherId, searchParams, loadExistingScheduleForDate]);

  const handleDateSelect = async (dateKey: string) => {
    if (registeredDates.includes(dateKey)) {
      await loadExistingScheduleForDate(dateKey);
      return;
    }

    setSuccessMessage("");
    setErrorMessage("");
    setSelectedDates((prev) =>
      prev.includes(dateKey) ? prev.filter((d) => d !== dateKey) : uniqueSorted([...prev, dateKey])
    );
  };

  const toggleBulkTime = (time: string) => {
    setBulkTimes((prev) =>
      prev.includes(time) ? prev.filter((t) => t !== time) : uniqueSorted([...prev, time])
    );

    setBulkLessonMethodMap((prev) => {
      const next = { ...prev };
      if (bulkTimes.includes(time)) delete next[time];
      else if (!next[time]) next[time] = [];
      return next;
    });
  };

  const toggleBulkLessonMethod = (time: string, method: string) => {
    setBulkLessonMethodMap((prev) => {
      const current = prev[time] || [];
      const nextMethods = current.includes(method)
        ? current.filter((m) => m !== method)
        : uniqueSorted([...current, method]);

      return { ...prev, [time]: nextMethods };
    });
  };

  const handleQuickSelectTimeRange = (range: QuickRangeKey) => {
    const rangeSlots = getQuickRangeSlots(range);
    setBulkTimes((prev) => uniqueSorted([...prev, ...rangeSlots]));
    setBulkLessonMethodMap((prev) => {
      const next = { ...prev };
      rangeSlots.forEach((time) => {
        if (!next[time]) next[time] = [];
      });
      return next;
    });
  };

  const applyBulkMethodToAllTimes = (method: string) => {
    if (bulkTimes.length === 0) {
      setErrorMessage("先に時間帯を選択してください。");
      return;
    }

    setBulkLessonMethodMap((prev) => {
      const next = { ...prev };
      bulkTimes.forEach((time) => {
        const current = next[time] || [];
        if (!current.includes(method)) next[time] = uniqueSorted([...current, method]);
      });
      return next;
    });
  };

  const applyBulkAllMethods = () => {
    if (bulkTimes.length === 0) {
      setErrorMessage("先に時間帯を選択してください。");
      return;
    }
    setBulkLessonMethodMap((prev) => {
      const next = { ...prev };
      bulkTimes.forEach((time) => {
        next[time] = [...LESSON_METHODS];
      });
      return next;
    });
  };

  const clearBulkMethods = () => {
    if (bulkTimes.length === 0) {
      setErrorMessage("先に時間帯を選択してください。");
      return;
    }
    setBulkLessonMethodMap((prev) => {
      const next = { ...prev };
      bulkTimes.forEach((time) => {
        next[time] = [];
      });
      return next;
    });
  };

  const togglePerDayTime = (date: string, time: string) => {
    setPerDaySettings((prev) => {
      const current = prev[date] || emptyPerDaySetting();
      const exists = current.times.includes(time);

      const nextTimes = exists
        ? current.times.filter((t) => t !== time)
        : uniqueSorted([...current.times, time]);

      const nextLessonMethodMap = { ...current.lessonMethodMap };
      if (exists) delete nextLessonMethodMap[time];
      else if (!nextLessonMethodMap[time]) nextLessonMethodMap[time] = [];

      return {
        ...prev,
        [date]: { times: nextTimes, lessonMethodMap: nextLessonMethodMap },
      };
    });
  };

  const togglePerDayLessonMethod = (date: string, time: string, method: string) => {
    setPerDaySettings((prev) => {
      const current = prev[date] || emptyPerDaySetting();
      const currentMethods = current.lessonMethodMap[time] || [];
      const nextMethods = currentMethods.includes(method)
        ? currentMethods.filter((m) => m !== method)
        : uniqueSorted([...currentMethods, method]);

      return {
        ...prev,
        [date]: {
          times: current.times,
          lessonMethodMap: { ...current.lessonMethodMap, [time]: nextMethods },
        },
      };
    });
  };

  const applyPerDayQuickRange = (date: string, range: QuickRangeKey) => {
    const rangeSlots = getQuickRangeSlots(range);

    setPerDaySettings((prev) => {
      const current = prev[date] || emptyPerDaySetting();
      const mergedTimes = uniqueSorted([...current.times, ...rangeSlots]);
      const nextMap = { ...current.lessonMethodMap };

      rangeSlots.forEach((time) => {
        if (!nextMap[time]) nextMap[time] = [];
      });

      return {
        ...prev,
        [date]: { times: mergedTimes, lessonMethodMap: nextMap },
      };
    });
  };

  const applyPerDayMethodToAllTimes = (date: string, method: string) => {
    setPerDaySettings((prev) => {
      const current = prev[date] || emptyPerDaySetting();
      if (current.times.length === 0) return prev;

      const nextMap = { ...current.lessonMethodMap };
      current.times.forEach((time) => {
        const methods = nextMap[time] || [];
        if (!methods.includes(method)) nextMap[time] = uniqueSorted([...methods, method]);
      });

      return {
        ...prev,
        [date]: { times: current.times, lessonMethodMap: nextMap },
      };
    });
  };

  const applyPerDayAllMethods = (date: string) => {
    setPerDaySettings((prev) => {
      const current = prev[date] || emptyPerDaySetting();
      if (current.times.length === 0) return prev;

      const nextMap = { ...current.lessonMethodMap };
      current.times.forEach((time) => {
        nextMap[time] = [...LESSON_METHODS];
      });

      return {
        ...prev,
        [date]: { times: current.times, lessonMethodMap: nextMap },
      };
    });
  };

  const clearPerDayMethods = (date: string) => {
    setPerDaySettings((prev) => {
      const current = prev[date] || emptyPerDaySetting();
      const nextMap: LessonMethodMap = {};
      current.times.forEach((time) => {
        nextMap[time] = [];
      });
      return {
        ...prev,
        [date]: { times: current.times, lessonMethodMap: nextMap },
      };
    });
  };

  const copyPerDaySetting = (date: string) => {
    const current = perDaySettings[date] || emptyPerDaySetting();
    setCopiedDaySourceDate(date);
    setCopiedDaySetting(clonePerDaySetting(current));
    setSuccessMessage(`${date} の設定をコピーしました。`);
    setErrorMessage("");
  };

  const pastePerDaySetting = (date: string) => {
    if (!copiedDaySetting) {
      setErrorMessage("先にコピー元の日付でコピーしてください。");
      return;
    }
    setPerDaySettings((prev) => ({
      ...prev,
      [date]: clonePerDaySetting(copiedDaySetting),
    }));
    setSuccessMessage(`${copiedDaySourceDate} の設定を ${date} に貼り付けました。`);
    setErrorMessage("");
  };

  const clearPerDayTimes = (date: string) => {
    setPerDaySettings((prev) => ({
      ...prev,
      [date]: { times: [], lessonMethodMap: {} },
    }));
  };

  const handleQuickSelectDates = (mode: QuickDateSelectKey) => {
    const currentMonthDateKeys = getSelectableDateKeysInMonth(displayMonth);

    const filtered = currentMonthDateKeys.filter((dateKey) => {
      const date = parseDateKey(dateKey);
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      const isHoliday = isJapaneseHoliday(date);

      if (mode === "weekday") return !isWeekend && !isHoliday;
      if (mode === "holiday") return isWeekend || isHoliday;
      if (mode === "holidayOnly") return isHoliday;
      if (mode === "all") return true;
      return false;
    });

    setSelectedDates((prev) => uniqueSorted([...prev, ...filtered]));
  };

  const clearSelectedDates = () => {
    setSelectedDates([]);
    setPerDaySettings({});
    setCopiedDaySourceDate("");
    setCopiedDaySetting(null);
    setEditingDate("");
  };

  const clearBulkTimes = () => {
    setBulkTimes([]);
    setBulkLessonMethodMap({});
    setEditingDate("");
  };

  const clearAllSelections = () => {
    setSelectedDates([]);
    setBulkTimes([]);
    setBulkLessonMethodMap({});
    setPerDaySettings({});
    setCopiedDaySourceDate("");
    setCopiedDaySetting(null);
    setEditingDate("");
    setSuccessMessage("");
    setErrorMessage("");
  };

  const toggleWeeklyTemplateTime = (time: string) => {
    setWeeklyTemplateTimes((prev) =>
      prev.includes(time) ? prev.filter((t) => t !== time) : uniqueSorted([...prev, time])
    );

    setWeeklyTemplateLessonMethodMap((prev) => {
      const next = { ...prev };
      if (weeklyTemplateTimes.includes(time)) delete next[time];
      else if (!next[time]) next[time] = [];
      return next;
    });
  };

  const toggleWeeklyTemplateLessonMethod = (time: string, method: string) => {
    setWeeklyTemplateLessonMethodMap((prev) => {
      const current = prev[time] || [];
      const nextMethods = current.includes(method)
        ? current.filter((m) => m !== method)
        : uniqueSorted([...current, method]);
      return { ...prev, [time]: nextMethods };
    });
  };

  const applyWeeklyTemplateQuickRange = (range: QuickRangeKey) => {
    const rangeSlots = getQuickRangeSlots(range);
    setWeeklyTemplateTimes((prev) => uniqueSorted([...prev, ...rangeSlots]));
    setWeeklyTemplateLessonMethodMap((prev) => {
      const next = { ...prev };
      rangeSlots.forEach((time) => {
        if (!next[time]) next[time] = [];
      });
      return next;
    });
  };

  const applyWeeklyTemplateMethodToAllTimes = (method: string) => {
    if (weeklyTemplateTimes.length === 0) {
      setErrorMessage("曜日定型登録では、先に時間帯を選択してください。");
      return;
    }

    setWeeklyTemplateLessonMethodMap((prev) => {
      const next = { ...prev };
      weeklyTemplateTimes.forEach((time) => {
        const current = next[time] || [];
        if (!current.includes(method)) next[time] = uniqueSorted([...current, method]);
      });
      return next;
    });
  };

  const applyWeeklyTemplateAllMethods = () => {
    if (weeklyTemplateTimes.length === 0) {
      setErrorMessage("曜日定型登録では、先に時間帯を選択してください。");
      return;
    }

    setWeeklyTemplateLessonMethodMap((prev) => {
      const next = { ...prev };
      weeklyTemplateTimes.forEach((time) => {
        next[time] = [...LESSON_METHODS];
      });
      return next;
    });
  };

  const clearWeeklyTemplateMethods = () => {
    if (weeklyTemplateTimes.length === 0) {
      setErrorMessage("曜日定型登録では、先に時間帯を選択してください。");
      return;
    }

    setWeeklyTemplateLessonMethodMap((prev) => {
      const next = { ...prev };
      weeklyTemplateTimes.forEach((time) => {
        next[time] = [];
      });
      return next;
    });
  };

  const clearWeeklyTemplate = () => {
    const defaultWeekday = 1;
    const nextRange = getFirstAndLastWeekdayInMonth(displayMonth, defaultWeekday);
    setWeeklyTemplateWeekday(defaultWeekday);
    setWeeklyTemplateStartDate(nextRange.start);
    setWeeklyTemplateEndDate(nextRange.end);
    setWeeklyTemplateTimes([]);
    setWeeklyTemplateLessonMethodMap({});
    setWeeklyTemplateOverwriteMode("skip");
  };

  const saveCurrentPattern = () => {
    setSuccessMessage("");
    setErrorMessage("");

    if (!teacherId) {
      setErrorMessage("ログイン情報が確認できませんでした。");
      return;
    }
    if (!patternName.trim()) {
      setErrorMessage("パターン名を入力してください。");
      return;
    }
    if (bulkTimes.length === 0) {
      setErrorMessage("保存する時間帯を選択してください。");
      return;
    }

    const invalidTimes = bulkTimes.filter(
      (time) => (bulkLessonMethodMap[time] || []).length === 0
    );
    if (invalidTimes.length > 0) {
      setErrorMessage(`場所未設定の時間があります: ${invalidTimes.join(", ")}`);
      return;
    }

    const newPattern: SavedPattern = {
      id: `${Date.now()}`,
      name: patternName.trim(),
      times: [...bulkTimes],
      lessonMethodMap: cloneLessonMethodMap(
        Object.fromEntries(bulkTimes.map((time) => [time, bulkLessonMethodMap[time] || []]))
      ),
      createdAt: new Date().toISOString(),
    };

    const nextPatterns = [newPattern, ...savedPatterns];
    setSavedPatterns(nextPatterns);
    savePatternsToStorage(teacherId, nextPatterns);
    setPatternName("");
    setSuccessMessage(`「${newPattern.name}」を保存しました。`);
  };

  const applySavedPattern = (pattern: SavedPattern) => {
    setBulkTimes([...pattern.times]);
    setBulkLessonMethodMap(cloneLessonMethodMap(pattern.lessonMethodMap));
    setSuccessMessage(`「${pattern.name}」を適用しました。`);
    setErrorMessage("");
  };

  const deleteSavedPattern = (patternId: string) => {
    if (!teacherId) return;
    const nextPatterns = savedPatterns.filter((p) => p.id !== patternId);
    setSavedPatterns(nextPatterns);
    savePatternsToStorage(teacherId, nextPatterns);
    setSuccessMessage("保存済みパターンを削除しました。");
    setErrorMessage("");
  };

  const applyBulkSettingsToSelectedDates = () => {
    setSuccessMessage("");
    setErrorMessage("");

    if (selectedDates.length === 0) {
      setErrorMessage("先に日付を選択してください。");
      return;
    }
    if (bulkTimes.length === 0) {
      setErrorMessage("先にまとめ設定の時間帯を選択してください。");
      return;
    }

    const invalidTimes = bulkTimes.filter(
      (time) => (bulkLessonMethodMap[time] || []).length === 0
    );
    if (invalidTimes.length > 0) {
      setErrorMessage(`場所未設定の時間があります: ${invalidTimes.join(", ")}`);
      return;
    }

    setPerDaySettings((prev) => {
      const next = { ...prev };
      selectedDates.forEach((date) => {
        next[date] = {
          times: [...bulkTimes],
          lessonMethodMap: Object.fromEntries(
            bulkTimes.map((time) => [time, [...(bulkLessonMethodMap[time] || [])]])
          ),
        };
      });
      return next;
    });

    setSuccessMessage(`${selectedDates.length}日へまとめ設定を反映しました。`);
  };

  const applyWeeklyTemplateToSelectedDates = async () => {
    setSuccessMessage("");
    setErrorMessage("");

    if (!teacherId) {
      setErrorMessage("ログイン情報が確認できませんでした。");
      return;
    }
    if (!weeklyTemplateStartDate || !weeklyTemplateEndDate) {
      setErrorMessage("曜日定型登録の対象期間を入力してください。");
      return;
    }
    if (weeklyTemplateStartDate > weeklyTemplateEndDate) {
      setErrorMessage("開始日が終了日以前になるようにしてください。");
      return;
    }
    if (weeklyTemplateTimes.length === 0) {
      setErrorMessage("曜日定型登録の時間帯を選択してください。");
      return;
    }

    const invalidTimes = weeklyTemplateTimes.filter(
      (time) => (weeklyTemplateLessonMethodMap[time] || []).length === 0
    );
    if (invalidTimes.length > 0) {
      setErrorMessage(`曜日定型登録で場所未設定の時間があります: ${invalidTimes.join(", ")}`);
      return;
    }

    const rangeDates = getDateRangeKeys(weeklyTemplateStartDate, weeklyTemplateEndDate);
    let targetDates = rangeDates.filter((dateKey) => {
      if (!selectedDates.includes(dateKey)) return false;
      if (isPastDateKey(dateKey)) return false;
      return parseDateKey(dateKey).getDay() === weeklyTemplateWeekday;
    });

    if (targetDates.length === 0) {
      setErrorMessage("選択日付の中に対象曜日の日がありませんでした。");
      return;
    }

    let appliedDates = [...targetDates];
    let skippedDates: string[] = [];

    if (weeklyTemplateOverwriteMode === "skip") {
      const existingDayDocMap = await buildExistingDayDocMap(targetDates);
      skippedDates = targetDates.filter((date) => (existingDayDocMap[date] || []).length > 0);
      appliedDates = targetDates.filter((date) => (existingDayDocMap[date] || []).length === 0);
    }

    if (appliedDates.length === 0) {
      setErrorMessage("適用対象の日付がありません。");
      return;
    }

    setPerDaySettings((prev) => {
      const next = { ...prev };
      appliedDates.forEach((date) => {
        next[date] = {
          times: [...weeklyTemplateTimes],
          lessonMethodMap: Object.fromEntries(
            weeklyTemplateTimes.map((time) => [
              time,
              [...(weeklyTemplateLessonMethodMap[time] || [])],
            ])
          ),
        };
      });
      return next;
    });

    const weekdayLabel =
      WEEKDAY_OPTIONS.find((item) => item.value === weeklyTemplateWeekday)?.label ?? "対象曜日";

    setSuccessMessage(
      [
        `${weekdayLabel}の定型設定を ${appliedDates.length} 日へ反映しました。`,
        skippedDates.length > 0 ? `既存データあり ${skippedDates.length} 日はスキップしました。` : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
  };

  const previewData = useMemo(() => {
    return selectedDates.map((date) => {
      const setting = perDaySettings[date];
      if (setting) {
        return {
          date,
          items: setting.times.map((time) => ({
            time,
            methods: setting.lessonMethodMap[time] || [],
          })),
          source: "perDay" as const,
        };
      }

      return {
        date,
        items: bulkTimes.map((time) => ({
          time,
          methods: bulkLessonMethodMap[time] || [],
        })),
        source: "bulk" as const,
      };
    });
  }, [selectedDates, perDaySettings, bulkTimes, bulkLessonMethodMap]);

  const totalSlotCount = useMemo(() => {
    return selectedDates.reduce((sum, date) => {
      const setting = perDaySettings[date];
      if (setting) return sum + setting.times.length;
      return sum + bulkTimes.length;
    }, 0);
  }, [selectedDates, perDaySettings, bulkTimes]);

  const handleSubmit = async () => {
    if (isSubmitting) return;

    setSuccessMessage("");
    setErrorMessage("");

    if (!teacherId) {
      setErrorMessage("ログイン情報が確認できませんでした。");
      return;
    }
    if (selectedDates.length === 0) {
      setErrorMessage("先に日付を選択してください。");
      return;
    }

    for (const date of selectedDates) {
      const setting = perDaySettings[date] || {
        times: bulkTimes,
        lessonMethodMap: bulkLessonMethodMap,
      };

      if (setting.times.length === 0) {
        setErrorMessage(`${date} の時間帯が未設定です。`);
        return;
      }

      const invalidTimes = setting.times.filter(
        (time) => (setting.lessonMethodMap[time] || []).length === 0
      );
      if (invalidTimes.length > 0) {
        setErrorMessage(`${date} で場所未設定の時間があります: ${invalidTimes.join(", ")}`);
        return;
      }
    }

    const isConfirmed = window.confirm(
      `選択日数: ${selectedDates.length}日\n登録予定枠数: ${totalSlotCount}件\n\nこの内容で登録しますか？`
    );
    if (!isConfirmed) return;

    setIsSubmitting(true);

    try {
      const docsToSave: Array<{ id: string; data: Record<string, unknown> }> = [];

      for (const date of selectedDates) {
        const setting = perDaySettings[date] || {
          times: bulkTimes,
          lessonMethodMap: bulkLessonMethodMap,
        };

        for (const time of setting.times) {
          docsToSave.push({
            id: buildSlotDocId(teacherId, date, time),
            data: {
              teacherId,
              date,
              time,
              slotMinutes: SLOT_MINUTES,
              lessonMethods: setting.lessonMethodMap[time] || [],
              status: "open",
              isAvailable: true,
              updatedAt: serverTimestamp(),
              createdAt: serverTimestamp(),
            },
          });
        }
      }

      const existingDayDocMap = await buildExistingDayDocMap(
        editingDate ? [editingDate] : selectedDates
      );
      const docsToKeepByDate: Record<string, Set<string>> = {};

      docsToSave.forEach((item) => {
        const date = typeof item.data.date === "string" ? item.data.date : "";
        if (!docsToKeepByDate[date]) docsToKeepByDate[date] = new Set<string>();
        docsToKeepByDate[date].add(item.id);
      });

      const deleteRefs: Array<{ collection: string; id: string }> = [];
      (editingDate ? [editingDate] : selectedDates).forEach((date) => {
        const existingDocs: ExistingDayDoc[] = existingDayDocMap[date] || [];
        const keepIds = docsToKeepByDate[date] || new Set<string>();

        existingDocs.forEach((existing: ExistingDayDoc) => {
          if (!keepIds.has(existing.docId)) {
            deleteRefs.push({ collection: SCHEDULES_COLLECTION, id: existing.docId });
          }
        });
      });

      const deleteChunks = chunkArray(deleteRefs, 200);
      const setChunks = chunkArray(docsToSave, 200);
      const maxLen = Math.max(deleteChunks.length, setChunks.length);

      for (let i = 0; i < maxLen; i += 1) {
        const batch = writeBatch(db);

        (deleteChunks[i] || []).forEach((item) => {
          batch.delete(doc(db, item.collection, item.id));
        });

        (setChunks[i] || []).forEach((item) => {
          batch.set(doc(db, SCHEDULES_COLLECTION, item.id), item.data, { merge: true });
        });

        await batch.commit();
      }

      await fetchRegisteredDates(displayMonth, teacherId);

      setSuccessMessage(
        editingDate
          ? `${editingDate} のスケジュールを更新しました。`
          : `${totalSlotCount}件のスケジュールを登録しました。`
      );

      setSelectedDates([]);
      setBulkTimes([]);
      setBulkLessonMethodMap({});
      setPerDaySettings({});
      setCopiedDaySourceDate("");
      setCopiedDaySetting(null);
      setEditingDate("");

      if (REDIRECT_AFTER_SAVE) navigate("/schedule-list");
    } catch (error) {
      console.error(error);
      setErrorMessage("スケジュール登録に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isAuthLoading) {
    return (
      <div className="schedule-form-page">
        <div className="schedule-form-container">
          <h1 className="schedule-form-title">スケジュール登録</h1>
          <p className="schedule-form-loading">ログイン情報を確認しています...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="schedule-form-page">
      <div className="schedule-form-container">
        <h1 className="schedule-form-title">スケジュール登録</h1>
        <p className="schedule-form-description">
          日付を選び、まずはまとめて設定し、必要な日だけ個別調整できます。
        </p>

        {successMessage && (
          <div className="schedule-form-message schedule-form-message--success">
            {successMessage}
          </div>
        )}
        {errorMessage && (
          <div className="schedule-form-message schedule-form-message--error">
            {errorMessage}
          </div>
        )}
        {editingDate && (
          <div className="schedule-form-message schedule-form-message--success">
            編集中の日付: <strong>{editingDate}</strong>
          </div>
        )}
        {isLoadingDateDetail && (
          <div className="schedule-form-message">登録済みスケジュールを読み込み中です...</div>
        )}

        <section className="schedule-form-section">
          <div className="schedule-form-section-header">
            <h2>1. 日付を選択</h2>
            <div className="schedule-form-section-actions">
              <button
                type="button"
                className="schedule-form-sub-button"
                onClick={() => handleQuickSelectDates("weekday")}
                disabled={isSubmitting}
              >
                平日を選択
              </button>
              <button
                type="button"
                className="schedule-form-sub-button"
                onClick={() => handleQuickSelectDates("holiday")}
                disabled={isSubmitting}
              >
                休日を選択
              </button>
              <button
                type="button"
                className="schedule-form-sub-button"
                onClick={() => handleQuickSelectDates("holidayOnly")}
                disabled={isSubmitting}
              >
                祝日を選択
              </button>
              <button
                type="button"
                className="schedule-form-sub-button"
                onClick={() => handleQuickSelectDates("all")}
                disabled={isSubmitting}
              >
                すべて選択
              </button>
              <button
                type="button"
                className="schedule-form-sub-button"
                onClick={clearSelectedDates}
                disabled={isSubmitting || selectedDates.length === 0}
              >
                日付選択をクリア
              </button>
            </div>
          </div>

          <BookingCalendar
            displayMonth={displayMonth}
            selectedDates={selectedDates}
            registeredDates={registeredDates}
            registeredSummaries={registeredSummaries}
            onChangeMonth={setDisplayMonth}
            onToggleDate={handleDateSelect}
          />

          <div className="schedule-form-status-row">
            <p className="schedule-form-status-text">
              選択中の日付: <strong>{selectedDates.length}</strong>日
            </p>
            <p className="schedule-form-status-text">
              {isLoadingRegisteredDates
                ? "登録済み日付を読み込み中..."
                : `この月の登録済み日付: ${registeredDates.length}日`}
            </p>
          </div>
        </section>

        <section className="schedule-form-section">
          <div className="schedule-form-section-header">
            <h2>2. まとめて設定</h2>
          </div>

          <div className="schedule-form-preview-block">
            <div className="schedule-form-section-header">
              <h3 className="schedule-form-preview-title">2-1. よく使うパターン</h3>
              <button
                type="button"
                className="schedule-form-sub-button"
                onClick={() => setIsPatternOpen((prev) => !prev)}
                disabled={isSubmitting}
              >
                {isPatternOpen ? "閉じる" : "開く"}
              </button>
            </div>

            {isPatternOpen && (
              <>
                <div className="schedule-form-weekly-grid">
                  <div className="schedule-form-weekly-row">
                    <label className="schedule-form-weekly-label">パターン名</label>
                    <div className="schedule-form-weekly-field">
                      <input
                        type="text"
                        className="schedule-form-date-input"
                        value={patternName}
                        onChange={(e) => setPatternName(e.target.value)}
                        placeholder="例: 平日午前 / 土日フル"
                        disabled={isSubmitting}
                      />
                    </div>
                  </div>
                </div>

                <div className="schedule-form-submit-row">
                  <button
                    type="button"
                    className="schedule-form-submit-button"
                    onClick={saveCurrentPattern}
                    disabled={isSubmitting}
                  >
                    現在のまとめ設定を保存
                  </button>
                </div>

                {savedPatterns.length > 0 && (
                  <div className="schedule-form-preview-groups">
                    <div className="schedule-form-preview-group">
                      {savedPatterns.map((pattern) => (
                        <div key={pattern.id} className="schedule-form-preview-card">
                          <div className="schedule-form-preview-date">{pattern.name}</div>
                          <div className="schedule-form-preview-items">
                            {pattern.times.map((time) => (
                              <div
                                key={`${pattern.id}-${time}`}
                                className="schedule-form-preview-row"
                              >
                                <span className="schedule-form-preview-time">{time}</span>
                                <span className="schedule-form-preview-arrow">→</span>
                                <span className="schedule-form-preview-methods">
                                  {(pattern.lessonMethodMap[time] || []).join(" / ")}
                                </span>
                              </div>
                            ))}
                          </div>
                          <div className="schedule-form-submit-row">
                            <button
                              type="button"
                              className="schedule-form-sub-button"
                              onClick={() => applySavedPattern(pattern)}
                              disabled={isSubmitting}
                            >
                              適用
                            </button>
                            <button
                              type="button"
                              className="schedule-form-clear-button"
                              onClick={() => deleteSavedPattern(pattern.id)}
                              disabled={isSubmitting}
                            >
                              削除
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="schedule-form-preview-block">
            <div className="schedule-form-section-header">
              <h3 className="schedule-form-preview-title">2-2. 曜日ごとの定型登録</h3>
              <button
                type="button"
                className="schedule-form-sub-button"
                onClick={() => setIsWeeklyTemplateOpen((prev) => !prev)}
                disabled={isSubmitting}
              >
                {isWeeklyTemplateOpen ? "閉じる" : "開く"}
              </button>
            </div>

            {isWeeklyTemplateOpen && (
              <>
                <div className="schedule-form-weekly-grid">
                  <div className="schedule-form-weekly-row">
                    <label className="schedule-form-weekly-label">対象曜日</label>
                    <div className="schedule-form-weekly-field">
                      <select
                        className="schedule-form-select schedule-form-select--compact"
                        value={weeklyTemplateWeekday}
                        onChange={(e) => setWeeklyTemplateWeekday(Number(e.target.value))}
                        disabled={isSubmitting}
                      >
                        {WEEKDAY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="schedule-form-weekly-row">
                    <label className="schedule-form-weekly-label">開始日</label>
                    <div className="schedule-form-weekly-field">
                      <input
                        type="text"
                        inputMode="numeric"
                        className="schedule-form-date-input"
                        value={formatDateKeyToSlash(weeklyTemplateStartDate)}
                        onChange={(e) =>
                          setWeeklyTemplateStartDate(normalizeSlashDateToHyphen(e.target.value))
                        }
                        placeholder="YYYY/MM/DD"
                        disabled={isSubmitting}
                      />
                    </div>
                  </div>

                  <div className="schedule-form-weekly-row">
                    <label className="schedule-form-weekly-label">終了日</label>
                    <div className="schedule-form-weekly-field">
                      <input
                        type="text"
                        inputMode="numeric"
                        className="schedule-form-date-input"
                        value={formatDateKeyToSlash(weeklyTemplateEndDate)}
                        onChange={(e) =>
                          setWeeklyTemplateEndDate(normalizeSlashDateToHyphen(e.target.value))
                        }
                        placeholder="YYYY/MM/DD"
                        disabled={isSubmitting}
                      />
                    </div>
                  </div>

                  <div className="schedule-form-weekly-row">
                    <label className="schedule-form-weekly-label">既存日の扱い</label>
                    <div className="schedule-form-weekly-field">
                      <select
                        className="schedule-form-select schedule-form-select--existing"
                        value={weeklyTemplateOverwriteMode}
                        onChange={(e) =>
                          setWeeklyTemplateOverwriteMode(e.target.value as WeeklyOverwriteMode)
                        }
                        disabled={isSubmitting}
                      >
                        <option value="skip">既存データありはスキップ</option>
                        <option value="overwrite">既存データありも上書き対象にする</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="schedule-form-section-header">
                  <h2>2-2-1. 定型の時間帯</h2>
                  <div className="schedule-form-section-actions">
                    <button
                      type="button"
                      className="schedule-form-sub-button"
                      onClick={() => applyWeeklyTemplateQuickRange("morning")}
                      disabled={isSubmitting}
                    >
                      午前を選択
                    </button>
                    <button
                      type="button"
                      className="schedule-form-sub-button"
                      onClick={() => applyWeeklyTemplateQuickRange("afternoon")}
                      disabled={isSubmitting}
                    >
                      午後を選択
                    </button>
                    <button
                      type="button"
                      className="schedule-form-sub-button"
                      onClick={() => applyWeeklyTemplateQuickRange("evening")}
                      disabled={isSubmitting}
                    >
                      夜を選択
                    </button>
                    <button
                      type="button"
                      className="schedule-form-sub-button"
                      onClick={() => applyWeeklyTemplateQuickRange("all")}
                      disabled={isSubmitting}
                    >
                      すべて選択
                    </button>
                    <button
                      type="button"
                      className="schedule-form-sub-button"
                      onClick={() => {
                        setWeeklyTemplateTimes([]);
                        setWeeklyTemplateLessonMethodMap({});
                      }}
                      disabled={isSubmitting || weeklyTemplateTimes.length === 0}
                    >
                      クリア
                    </button>
                  </div>
                </div>

                <div className="schedule-form-time-grid">
                  {TIME_SLOTS.map((time) => (
                    <button
                      key={`weekly-${time}`}
                      type="button"
                      className={`schedule-form-time-button ${
                        weeklyTemplateTimes.includes(time) ? "is-selected" : ""
                      }`}
                      onClick={() => toggleWeeklyTemplateTime(time)}
                      disabled={isSubmitting}
                    >
                      {time}
                    </button>
                  ))}
                </div>

                {weeklyTemplateTimes.length > 0 && (
                  <>
                    <div className="schedule-form-bulk-method-actions">
                      <button
                        type="button"
                        className="schedule-form-sub-button"
                        onClick={() => applyWeeklyTemplateMethodToAllTimes("自宅")}
                        disabled={isSubmitting}
                      >
                        一括で自宅を追加
                      </button>
                      <button
                        type="button"
                        className="schedule-form-sub-button"
                        onClick={() => applyWeeklyTemplateMethodToAllTimes("スタジオ")}
                        disabled={isSubmitting}
                      >
                        一括でスタジオを追加
                      </button>
                      <button
                        type="button"
                        className="schedule-form-sub-button"
                        onClick={() => applyWeeklyTemplateMethodToAllTimes("出張")}
                        disabled={isSubmitting}
                      >
                        一括で出張を追加
                      </button>
                      <button
                        type="button"
                        className="schedule-form-sub-button"
                        onClick={applyWeeklyTemplateAllMethods}
                        disabled={isSubmitting}
                      >
                        一括ですべて追加
                      </button>
                      <button
                        type="button"
                        className="schedule-form-sub-button"
                        onClick={clearWeeklyTemplateMethods}
                        disabled={isSubmitting}
                      >
                        一括で場所をクリア
                      </button>
                    </div>

                    <div className="schedule-form-method-time-grid">
                      {weeklyTemplateTimes.map((time) => {
                        const methods = weeklyTemplateLessonMethodMap[time] || [];
                        return (
                          <div key={`weekly-method-${time}`} className="schedule-form-method-time-card">
                            <div className="schedule-form-method-time-header">
                              <div className="schedule-form-method-time-label">
                                {time} のレッスン場所
                              </div>
                            </div>
                            <div className="schedule-form-method-button-grid">
                              {LESSON_METHODS.map((method) => (
                                <button
                                  key={`weekly-${time}-${method}`}
                                  type="button"
                                  className={`schedule-form-time-button ${
                                    methods.includes(method) ? "is-selected" : ""
                                  }`}
                                  onClick={() => toggleWeeklyTemplateLessonMethod(time, method)}
                                  disabled={isSubmitting}
                                >
                                  {method}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                <div className="schedule-form-summary-box">
                  <p>
                    対象日数: <strong>{weeklyTemplatePreviewDates.length}</strong>日
                  </p>
                  <p>
                    選択時間数: <strong>{weeklyTemplateTimes.length}</strong>枠
                  </p>
                </div>

                <div className="schedule-form-submit-row">
                  <button
                    type="button"
                    className="schedule-form-clear-button"
                    onClick={clearWeeklyTemplate}
                    disabled={isSubmitting}
                  >
                    定型設定をクリア
                  </button>
                  <button
                    type="button"
                    className="schedule-form-submit-button"
                    onClick={applyWeeklyTemplateToSelectedDates}
                    disabled={isSubmitting}
                  >
                    選択日へ定型を反映
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="schedule-form-preview-block">
            <h3 className="schedule-form-preview-title">2-3. まとめて時間帯と場所を設定</h3>

            <div className="schedule-form-section-header">
              <h2>まとめて時間帯を選択</h2>
              <div className="schedule-form-section-actions">
                <button
                  type="button"
                  className="schedule-form-sub-button"
                  onClick={() => handleQuickSelectTimeRange("morning")}
                  disabled={isSubmitting}
                >
                  午前を選択
                </button>
                <button
                  type="button"
                  className="schedule-form-sub-button"
                  onClick={() => handleQuickSelectTimeRange("afternoon")}
                  disabled={isSubmitting}
                >
                  午後を選択
                </button>
                <button
                  type="button"
                  className="schedule-form-sub-button"
                  onClick={() => handleQuickSelectTimeRange("evening")}
                  disabled={isSubmitting}
                >
                  夜を選択
                </button>
                <button
                  type="button"
                  className="schedule-form-sub-button"
                  onClick={() => handleQuickSelectTimeRange("all")}
                  disabled={isSubmitting}
                >
                  すべて選択
                </button>
                <button
                  type="button"
                  className="schedule-form-sub-button"
                  onClick={clearBulkTimes}
                  disabled={isSubmitting || bulkTimes.length === 0}
                >
                  時間選択をクリア
                </button>
              </div>
            </div>

            <div className="schedule-form-time-grid">
              {TIME_SLOTS.map((time) => (
                <button
                  key={time}
                  type="button"
                  className={`schedule-form-time-button ${bulkTimes.includes(time) ? "is-selected" : ""}`}
                  onClick={() => toggleBulkTime(time)}
                  disabled={isSubmitting}
                >
                  {time}
                </button>
              ))}
            </div>

            {bulkTimes.length > 0 && (
              <>
                <div className="schedule-form-bulk-method-actions">
                  <button
                    type="button"
                    className="schedule-form-sub-button"
                    onClick={() => applyBulkMethodToAllTimes("自宅")}
                    disabled={isSubmitting}
                  >
                    一括で自宅を追加
                  </button>
                  <button
                    type="button"
                    className="schedule-form-sub-button"
                    onClick={() => applyBulkMethodToAllTimes("スタジオ")}
                    disabled={isSubmitting}
                  >
                    一括でスタジオを追加
                  </button>
                  <button
                    type="button"
                    className="schedule-form-sub-button"
                    onClick={() => applyBulkMethodToAllTimes("出張")}
                    disabled={isSubmitting}
                  >
                    一括で出張を追加
                  </button>
                  <button
                    type="button"
                    className="schedule-form-sub-button"
                    onClick={applyBulkAllMethods}
                    disabled={isSubmitting}
                  >
                    一括ですべて追加
                  </button>
                  <button
                    type="button"
                    className="schedule-form-sub-button"
                    onClick={clearBulkMethods}
                    disabled={isSubmitting}
                  >
                    一括で場所をクリア
                  </button>
                </div>

                <div className="schedule-form-method-time-grid">
                  {bulkTimes.map((time) => {
                    const methods = bulkLessonMethodMap[time] || [];
                    return (
                      <div key={time} className="schedule-form-method-time-card">
                        <div className="schedule-form-method-time-header">
                          <div className="schedule-form-method-time-label">
                            {time} のレッスン場所
                          </div>
                        </div>
                        <div className="schedule-form-method-button-grid">
                          {LESSON_METHODS.map((method) => (
                            <button
                              key={`${time}-${method}`}
                              type="button"
                              className={`schedule-form-time-button ${
                                methods.includes(method) ? "is-selected" : ""
                              }`}
                              onClick={() => toggleBulkLessonMethod(time, method)}
                              disabled={isSubmitting}
                            >
                              {method}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="schedule-form-submit-row">
                  <button
                    type="button"
                    className="schedule-form-submit-button"
                    onClick={applyBulkSettingsToSelectedDates}
                    disabled={isSubmitting}
                  >
                    選択日へまとめ設定を反映
                  </button>
                </div>
              </>
            )}
          </div>
        </section>

        <section className="schedule-form-section">
          <div className="schedule-form-section-header">
            <h2>3. 日ごとの個別調整</h2>
          </div>

          <div className="schedule-form-perday-list">
            {selectedDates.length === 0 ? (
              <p className="schedule-form-preview-empty">先に日付を選択してください。</p>
            ) : (
              selectedDates.map((date) => {
                const setting = perDaySettings[date] || emptyPerDaySetting();

                return (
                  <div key={date} className="schedule-form-perday-card">
                    <div className="schedule-form-perday-header">
                      <div className="schedule-form-perday-title">{date}</div>
                      <div className="schedule-form-section-actions">
                        <button
                          type="button"
                          className="schedule-form-sub-button"
                          onClick={() => applyPerDayQuickRange(date, "morning")}
                          disabled={isSubmitting}
                        >
                          午前
                        </button>
                        <button
                          type="button"
                          className="schedule-form-sub-button"
                          onClick={() => applyPerDayQuickRange(date, "afternoon")}
                          disabled={isSubmitting}
                        >
                          午後
                        </button>
                        <button
                          type="button"
                          className="schedule-form-sub-button"
                          onClick={() => applyPerDayQuickRange(date, "evening")}
                          disabled={isSubmitting}
                        >
                          夜
                        </button>
                        <button
                          type="button"
                          className="schedule-form-sub-button"
                          onClick={() => applyPerDayQuickRange(date, "all")}
                          disabled={isSubmitting}
                        >
                          すべて
                        </button>
                        <button
                          type="button"
                          className="schedule-form-sub-button"
                          onClick={() => copyPerDaySetting(date)}
                          disabled={isSubmitting}
                        >
                          この日をコピー
                        </button>
                        <button
                          type="button"
                          className="schedule-form-sub-button"
                          onClick={() => pastePerDaySetting(date)}
                          disabled={isSubmitting || !copiedDaySetting}
                        >
                          ここに貼り付け
                        </button>
                        <button
                          type="button"
                          className="schedule-form-sub-button"
                          onClick={() => clearPerDayTimes(date)}
                          disabled={isSubmitting || setting.times.length === 0}
                        >
                          この日の時間をクリア
                        </button>
                      </div>
                    </div>

                    {copiedDaySetting && (
                      <p className="schedule-form-copy-hint">
                        コピー元: {copiedDaySourceDate || "未設定"}
                      </p>
                    )}

                    <div className="schedule-form-time-grid">
                      {TIME_SLOTS.map((time) => (
                        <button
                          key={`${date}-${time}`}
                          type="button"
                          className={`schedule-form-time-button ${
                            setting.times.includes(time) ? "is-selected" : ""
                          }`}
                          onClick={() => togglePerDayTime(date, time)}
                          disabled={isSubmitting}
                        >
                          {time}
                        </button>
                      ))}
                    </div>

                    {setting.times.length > 0 && (
                      <div className="schedule-form-method-block">
                        <div className="schedule-form-bulk-method-actions">
                          <button
                            type="button"
                            className="schedule-form-sub-button"
                            onClick={() => applyPerDayMethodToAllTimes(date, "自宅")}
                            disabled={isSubmitting}
                          >
                            この日すべてに自宅
                          </button>
                          <button
                            type="button"
                            className="schedule-form-sub-button"
                            onClick={() => applyPerDayMethodToAllTimes(date, "スタジオ")}
                            disabled={isSubmitting}
                          >
                            この日すべてにスタジオ
                          </button>
                          <button
                            type="button"
                            className="schedule-form-sub-button"
                            onClick={() => applyPerDayMethodToAllTimes(date, "出張")}
                            disabled={isSubmitting}
                          >
                            この日すべてに出張
                          </button>
                          <button
                            type="button"
                            className="schedule-form-sub-button"
                            onClick={() => applyPerDayAllMethods(date)}
                            disabled={isSubmitting}
                          >
                            この日すべて追加
                          </button>
                          <button
                            type="button"
                            className="schedule-form-sub-button"
                            onClick={() => clearPerDayMethods(date)}
                            disabled={isSubmitting}
                          >
                            この日の場所をクリア
                          </button>
                        </div>

                        <div className="schedule-form-method-time-grid">
                          {setting.times.map((time) => {
                            const methods = setting.lessonMethodMap[time] || [];
                            return (
                              <div
                                key={`${date}-${time}-methods`}
                                className="schedule-form-method-time-card"
                              >
                                <div className="schedule-form-method-time-header">
                                  <div className="schedule-form-method-time-label">
                                    {time} のレッスン場所
                                  </div>
                                </div>
                                <div className="schedule-form-method-button-grid">
                                  {LESSON_METHODS.map((method) => (
                                    <button
                                      key={`${date}-${time}-${method}`}
                                      type="button"
                                      className={`schedule-form-time-button ${
                                        methods.includes(method) ? "is-selected" : ""
                                      }`}
                                      onClick={() => togglePerDayLessonMethod(date, time, method)}
                                      disabled={isSubmitting}
                                    >
                                      {method}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="schedule-form-section schedule-form-summary">
          <h2>4. 登録内容の確認</h2>

          <div className="schedule-form-summary-box">
            <p>
              選択日数: <strong>{selectedDates.length}</strong>日
            </p>
            <p>
              まとめ設定の時間数: <strong>{bulkTimes.length}</strong>枠
            </p>
            <p>
              個別調整済み日数:{" "}
              <strong>
                {Object.keys(perDaySettings).filter((date) => selectedDates.includes(date)).length}
              </strong>
              日
            </p>
            <p>
              登録予定枠数: <strong>{totalSlotCount}</strong>件
            </p>
          </div>

          <div className="schedule-form-preview-block">
            <h3 className="schedule-form-preview-title">最終プレビュー</h3>

            {selectedDates.length === 0 ? (
              <p className="schedule-form-preview-empty">
                日付を選択すると、ここに登録予定内容が表示されます。
              </p>
            ) : (
              <div className="schedule-form-preview-groups">
                <div className="schedule-form-preview-group">
                  {previewData.map((day) => (
                    <div key={day.date} className="schedule-form-preview-card">
                      <div className="schedule-form-preview-date">
                        {day.date} {day.source === "perDay" ? "（個別調整）" : "（まとめ設定）"}
                      </div>
                      <div className="schedule-form-preview-items">
                        {day.items.length === 0 ? (
                          <div className="schedule-form-preview-row">
                            <span className="schedule-form-preview-methods">時間未設定</span>
                          </div>
                        ) : (
                          day.items.map((item) => (
                            <div key={`${day.date}-${item.time}`} className="schedule-form-preview-row">
                              <span className="schedule-form-preview-time">{item.time}</span>
                              <span className="schedule-form-preview-arrow">→</span>
                              <span className="schedule-form-preview-methods">
                                {item.methods.length > 0 ? item.methods.join(" / ") : "場所未設定"}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="schedule-form-submit-row">
            <button
              type="button"
              className="schedule-form-clear-button"
              onClick={clearAllSelections}
              disabled={isSubmitting}
            >
              選択をすべてクリア
            </button>

            <button
              type="button"
              className="schedule-form-submit-button"
              onClick={handleSubmit}
              disabled={isSubmitting || !teacherId || selectedDates.length === 0}
            >
              {isSubmitting ? "登録中..." : editingDate ? "この日を更新する" : "まとめて登録する"}
            </button>
          </div>

          {isSubmitting && (
            <p className="schedule-form-submitting-note">
              保存中です。完了するまで画面を閉じずにお待ちください。
            </p>
          )}
        </section>
      </div>
    </div>
  );
}