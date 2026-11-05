import type { AssetKind } from "./types";

/** The wording changes per kind, but the fields do not. */
export const ACCOUNT_COPY: Record<AssetKind, { title: string; password: string; hint: string }> = {
  server: {
    title: "面板 / 控制台账号",
    password: "密码",
    hint: "云厂商控制台或管理面板的登录信息，与上面的 SSH 凭据分开保存。",
  },
  domain: {
    title: "注册商账号",
    password: "密码",
    hint: "注册商后台的登录信息，续费时不用再翻密码本。",
  },
  mail: {
    title: "邮箱账号",
    password: "密码 / 授权码",
    hint: "IMAP/SMTP 授权码通常与登录密码不同，可写在备注里。",
  },
  ai: { title: "服务商账号", password: "密码", hint: "订阅账号、API Key 与恢复码都可以放这里。" },
  secret: {
    title: "密钥内容",
    password: "完整值",
    hint: "完整值只存在加密库中，资产文件里只留提示片段。",
  },
  service: { title: "服务商账号", password: "密码", hint: "签发或托管平台的登录信息。" },
  cert: { title: "签发平台账号", password: "密码", hint: "签发或托管平台的登录信息。" },
};

export const WEBSITE_ACCOUNT_COPY = {
  title: "网站登录账号",
  password: "密码",
  hint: "登录地址、账号和密码保存在加密库中，可在资产详情关联注册邮箱。",
};

export const STANDALONE_ACCOUNT_COPY = {
  title: "账号密码",
  password: "密码",
  hint: "账户名、密码、登录网址和敏感备注只保存在加密密钥库中。关联文档仅保存引用，不会复制凭据。",
};
