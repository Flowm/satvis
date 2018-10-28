import dayjs from "dayjs";

export class PushManager {
  constructor(options = {}) {
    this.options = options;
    this.timers = [];
  }

  requestPermission() {
    if (!("Notification" in window)) {
      console.log("Notification API not supported!");
      return;
    }

    Notification.requestPermission((result) => {
      console.log("Notifcation permission result: " + result);
    });
  }

  available() {
    if (!("Notification" in window) || !("ServiceWorkerRegistration" in window)) {
      console.log("Persistent Notification API not supported!");
      return false;
    }
    return true;
  }

  get active() {
    return this.timers.length > 0;
  }

  clearTimers() {
    this.timers.forEach((timer) => {
      clearTimeout(timer.id);
    });
    this.timers = [];
  }

  persistentNotification(message, options) {
    if (!this.available()) {
      return;
    }
    options = {...this.options, ...options};
    try {
      navigator.serviceWorker.getRegistration()
        .then(reg => reg.showNotification(message, options))
        .catch(err => console.log("Service Worker registration error: " + err));
    } catch (err) {
      console.log("Notification API error: " + err);
    }
  }

  notifyInMs(ms, message, options) {
    if (!this.available()) {
      return;
    }
    console.log(`Notify "${message}" in ${ms / 1000}s`);
    setTimeout(() => { this.persistentNotification(message, options); }, ms);
  }

  notifyAtDate(date, message, options) {
    let waitMs = dayjs(date).diff(dayjs());
    if (waitMs < 0) {
      return;
    }
    if (this.timers.some((timer) => timer.date.isSame(date))) {
      console.log("Ignore duplicate entry");
      return;
    }
    console.log(`Notify "${message}" at ${date}s`);

    let id = setTimeout(() => { this.persistentNotification(message, options); }, waitMs);
    this.timers.push({
      id: id,
      date: date,
      message: message,
    });
  }
}
