import dayjs from "dayjs";

export class PushManager {
  constructor(options = {}) {
    this.options = options;
    this.timers = [];
  }

  get available() {
    if ("webkit" in window) {
      return true;
    }
    if (!("Notification" in window) || !("ServiceWorkerRegistration" in window)) {
      console.log("Notification API not supported!");
      return false;
    }
    switch(Notification.permission) {
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

  requestPermission() {
    Notification.requestPermission((result) => {
      console.log("Notifcation permission result: " + result);
    });
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
    if (!this.available) {
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
    if (!this.available) {
      return;
    }
    console.log(`Notify "${message}" in ${ms / 1000}s`);
    setTimeout(() => { this.persistentNotification(message, options); }, ms);
  }

  notifyAtDate(date, message, options) {
    if (!this.available) {
      return;
    }
    let waitMs = dayjs(date).diff(dayjs());
    if (waitMs < 0) {
      return;
    }
    if (this.timers.some((timer) => Math.abs(timer.date.diff(date, "seconds")) < 10)) {
      console.log("Ignore duplicate entry");
      return;
    }
    console.log(`Notify "${message}" at ${date}s ${dayjs(date).unix()}`);

    if ("webkit" in window) {
      let content = {
        date: dayjs(date).unix(),
        delay: waitMs/1000,
        message: message,
      };
      window.webkit.messageHandlers.iosNotify.postMessage(content);
    } else {
      let id = setTimeout(() => { this.persistentNotification(message, options); }, waitMs);
      this.timers.push({
        id: id,
        date: date,
        message: message,
      });
    }
  }
}
