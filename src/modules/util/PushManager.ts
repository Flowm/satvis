import dayjs from "dayjs";

export interface PushNotificationOptions extends NotificationOptions {
  [key: string]: unknown;
}

interface TimerEntry {
  id: ReturnType<typeof setTimeout>;
  date: Date | string | number | dayjs.Dayjs;
  message: string;
}

/** Non-standard webkit message-handler bridge used by the iOS wrapper app */
interface WebkitWindow {
  webkit?: {
    messageHandlers: {
      iosNotify: {
        postMessage(content: unknown, origin: string): void;
      };
    };
  };
}

export class PushManager {
  options: PushNotificationOptions;

  timers: TimerEntry[] = [];

  constructor(options: PushNotificationOptions = {}) {
    this.options = options;
  }

  get available(): boolean {
    if ("webkit" in window) {
      return true;
    }
    if (!("Notification" in window) || !("ServiceWorkerRegistration" in window)) {
      console.log("Notification API not supported!");
      return false;
    }
    switch (Notification.permission) {
      case "granted":
        return true;
      case "default":
        this.requestPermission();
        return true;
      case "denied":
        return false;
      default:
        return false;
    }
  }

  requestPermission(): void {
    Notification.requestPermission().then((result) => {
      console.log(`Notifcation permission result: ${result}`);
    });
  }

  get active(): boolean {
    return this.timers.length > 0;
  }

  clearTimers(): void {
    this.timers.forEach((timer) => {
      clearTimeout(timer.id);
    });
    this.timers = [];
  }

  persistentNotification(message: string, options?: PushNotificationOptions): void {
    if (!this.available) {
      return;
    }
    const optionsMerged = { ...this.options, ...options };
    try {
      navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg?.showNotification(message, optionsMerged))
        .catch((err) => console.log(`Service Worker registration error: ${err}`));
    } catch (err) {
      console.log(`Notification API error: ${err}`);
    }
  }

  notifyInMs(ms: number, message: string, options?: PushNotificationOptions): void {
    if (!this.available) {
      return;
    }
    console.log(`Notify "${message}" in ${ms / 1000}s`);
    setTimeout(() => {
      this.persistentNotification(message, options);
    }, ms);
  }

  notifyAtDate(date: Date | string | number, message: string, options?: PushNotificationOptions): void {
    if (!this.available) {
      return;
    }
    const waitMs = dayjs(date).diff(dayjs());
    if (waitMs < 0) {
      return;
    }
    if (this.timers.some((timer) => Math.abs(dayjs(timer.date as Date).diff(date, "seconds")) < 10)) {
      console.log("Ignore duplicate entry");
      return;
    }
    console.log(`Notify "${message}" at ${date}s ${dayjs(date).unix()}`);

    if ("webkit" in window) {
      const content = {
        date: dayjs(date).unix(),
        delay: waitMs / 1000,
        message,
      };
      const w = window as unknown as WebkitWindow;
      w.webkit?.messageHandlers.iosNotify.postMessage(content, self.location.origin);
    } else {
      const id = setTimeout(() => {
        this.persistentNotification(message, options);
      }, waitMs);
      this.timers.push({
        id,
        date,
        message,
      });
    }
  }
}
