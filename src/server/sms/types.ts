/** 短信发送接口；生产实现为国内短信服务，本地为模拟实现（见 mock.ts）。 */
export interface SmsSender {
  send(phone: string, code: string): Promise<void>;
}
