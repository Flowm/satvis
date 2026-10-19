import dayjs from "dayjs";

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
  /** When each scheduled notification fires, to drop a duplicate. */
  #scheduled: (Date | string | number)[] = [];

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

  persistentNotification(message: string): void {
    if (!this.available) {
      return;
    }
    try {
      navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg?.showNotification(message))
        .catch((err) => console.log(`Service Worker registration error: ${err}`));
    } catch (err) {
      console.log(`Notification API error: ${err}`);
    }
  }

  notifyAtDate(date: Date | string | number, message: string): void {
    if (!this.available) {
      return;
    }
    const waitMs = dayjs(date).diff(dayjs());
    if (waitMs < 0) {
      return;
    }
    if (this.#scheduled.some((scheduled) => Math.abs(dayjs(scheduled).diff(date, "seconds")) < 10)) {
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
      setTimeout(() => {
        this.persistentNotification(message);
      }, waitMs);
      this.#scheduled.push(date);
    }
  }
}
