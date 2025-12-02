"use client";

import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { Html5Qrcode } from "html5-qrcode";
import EthereumProvider from "@walletconnect/ethereum-provider";

const DROP_NFT_ADDRESS = process.env.NEXT_PUBLIC_DROP_NFT_ADDRESS as string;

const DROP_NFT_ABI = [
  "function mint(address to, bytes32 hash, uint8 v, bytes32 r, bytes32 s) external",
];

export default function Home() {
  const [account, setAccount] = useState<string | null>(null);
  const [hash, setHash] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [walletSource, setWalletSource] = useState<"walletconnect" | null>(null);
  const [wcConnecting, setWcConnecting] = useState(false);

  const qrCodeRegionId = "hash-qr-reader";
  const html5QrCodeRef = useRef<Html5Qrcode | null>(null);
  const wcProviderRef = useRef<any | null>(null);

  useEffect(() => {
    return () => {
      if (html5QrCodeRef.current) {
        html5QrCodeRef.current
          .stop()
          .then(() => html5QrCodeRef.current?.clear())
          .catch(() => {});
      }

      if (wcProviderRef.current?.disconnect) {
        try {
          wcProviderRef.current.disconnect();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  const disconnectWalletConnect = async () => {
    const provider = wcProviderRef.current as any;

    if (provider && typeof provider.disconnect === "function") {
      try {
        await provider.disconnect();
      } catch {
        // ignore
      }
    }

    wcProviderRef.current = null;
    setAccount(null);
    setWalletSource(null);
  };

  const connectWalletConnect = async () => {
    setError(null);
    setTxHash(null);
    setWcConnecting(true);

    try {
      const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
      if (!projectId) {
        setError("未配置 NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID");
        return;
      }

      const isDev = process.env.NODE_ENV !== "production";
      const chainId = isDev ? 97 : 56; // dev 用 BSC Testnet，生产用 BSC 主网

      const wcProvider = await EthereumProvider.init({
        projectId,
        chains: [chainId],
        showQrModal: true,
      });

      await wcProvider.enable();
      wcProviderRef.current = wcProvider;

      const provider = new ethers.BrowserProvider(wcProvider as any);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();

      setAccount(address);
      setWalletSource("walletconnect");
    } catch (e: any) {
      const msg = e?.message || e?.toString?.() || "";

      if (typeof msg === "string") {
        // 用户在钱包中关闭/取消连接，不当作错误提示
        if (msg.includes("User closed") || msg.includes("User rejected")) {
          return;
        }

        // WalletConnect 会话失效
        if (
          msg.includes("session topic doesn't exist") ||
          msg.includes("No matching key")
        ) {
          await disconnectWalletConnect();
          setError("WalletConnect 会话已失效，请重新连接钱包。");
          return;
        }
      }

      setError(msg || "WalletConnect 连接失败");
    } finally {
      setWcConnecting(false);
    }
  };

  const handleConnectButtonClick = async () => {
    if (account && walletSource === "walletconnect" && wcProviderRef.current) {
      await disconnectWalletConnect();
    }
    await connectWalletConnect();
  };

  const startScan = async () => {
    setScanError(null);

    if (typeof window === "undefined") {
      setScanError("当前环境不支持扫码");
      return;
    }

    try {
      if (!html5QrCodeRef.current) {
        html5QrCodeRef.current = new Html5Qrcode(qrCodeRegionId);
      }

      setScanning(true);

      await html5QrCodeRef.current.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        (decodedText) => {
          if (decodedText) {
            setHash(decodedText);
            if (html5QrCodeRef.current) {
              html5QrCodeRef.current
                .stop()
                .then(() => html5QrCodeRef.current?.clear())
                .catch(() => {})
                .finally(() => {
                  setScanning(false);
                });
            } else {
              setScanning(false);
            }
          }
        },
        () => {}
      );
    } catch (e: any) {
      setScanError(e?.message || "启动扫码失败，请检查摄像头权限");
      setScanning(false);
    }
  };

  const stopScan = async () => {
    if (!html5QrCodeRef.current) {
      setScanning(false);
      return;
    }

    try {
      await html5QrCodeRef.current.stop();
      await html5QrCodeRef.current.clear();
    } catch {
      // ignore
    } finally {
      setScanning(false);
    }
  };

  const handleMint = async () => {
    setError(null);
    setTxHash(null);
    setTxStatus(null);

    if (!account || walletSource !== "walletconnect" || !wcProviderRef.current) {
      setError("请先通过 WalletConnect 连接钱包");
      return;
    }
    if (!hash.trim()) {
      setError("请输入哈希");
      return;
    }

    setLoading(true);
    try {
      if (!DROP_NFT_ADDRESS) {
        setError("未配置 NEXT_PUBLIC_DROP_NFT_ADDRESS");
        return;
      }

      // 1. 调用后端获取签名
      const res = await fetch("/api/mint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          hash: hash.trim(),
          address: account,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data?.error || "后端返回错误");
        return;
      }

      // data: { hash, address, v, r, s }
      if (!data?.hash || data.r == null || data.s == null || data.v == null) {
        setError("后端返回数据不完整");
        return;
      }

      const isDev = process.env.NODE_ENV !== "production";
      const expectedChainId = isDev ? 97 : 56;

      const chainIdHex = await wcProviderRef.current.request({
        method: "eth_chainId",
      });
      const currentChainId = Number(chainIdHex);

      if (currentChainId !== expectedChainId) {
        setError(
          `钱包当前网络为 ${currentChainId}，请在钱包中切换到 BSC ${
            isDev ? "Testnet (97)" : "Mainnet (56)"
          } 后重新尝试。`
        );
        return;
      }

      // 2. 使用当前钱包发起 DropNFT.mint 交易
      const provider = new ethers.BrowserProvider(wcProviderRef.current as any);
      const signer = await provider.getSigner();

      const contract = new ethers.Contract(
        DROP_NFT_ADDRESS,
        DROP_NFT_ABI,
        signer
      );

      const tx = await contract.mint(
        account,
        data.hash,
        data.v,
        data.r,
        data.s
      );
      const currentTxHash = tx.hash;
      setTxHash(currentTxHash);
      setTxStatus("pending");

      // 3. 将 txHash 上报给后端，并轮询后端状态
      try {
        await fetch("/api/mint/tx", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            hash: data.hash,
            address: account,
            txHash: currentTxHash,
          }),
        });
      } catch (e) {
        // 上报失败不直接打断前端流程，仅记录错误提示
        console.error("report txHash error", e);
      }

      const pollStatus = async () => {
        try {
          const res = await fetch(
            `/api/mint/status?txHash=${currentTxHash}`
          );
          const statusData = await res.json();

          if (!res.ok) {
            setError(statusData?.error || "查询交易状态失败");
            return;
          }

          const status = statusData?.status as string | undefined;
          if (!status) {
            setError("后端返回的状态为空");
            return;
          }

          setTxStatus(status);

          if (status === "pending") {
            setTimeout(pollStatus, 3000);
          }
        } catch (e) {
          console.error("poll tx status error", e);
          // 临时网络错误，稍后重试
          setTimeout(pollStatus, 3000);
        }
      };

      // 启动状态轮询
      pollStatus();
    } catch (e: any) {
      const msg = e?.message || e?.toString?.() || "";

      if (typeof msg === "string") {
        // 用户在钱包中取消交易/拒绝签名，不当作错误提示
        if (
          msg.includes("User rejected") ||
          msg.includes("User denied") ||
          msg.includes("rejected the request")
        ) {
          return;
        }

        // WalletConnect 会话失效，清理状态并提示重新连接
        if (
          msg.includes("session topic doesn't exist") ||
          msg.includes("No matching key")
        ) {
          await disconnectWalletConnect();
          setError("WalletConnect 会话已失效，请重新连接钱包后再尝试。");
          return;
        }
      }

      setError(msg || "请求失败");
    } finally {
      setLoading(false);
    }
  };

  const bscScanUrl = txHash
    ? `https://bscscan.com/tx/${txHash}`
    : null;

  return (
    <div className="flex min-h-screen items-stretch justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex min-h-screen w-full max-w-xl flex-col gap-6 px-4 py-6 bg-white dark:bg-black sm:gap-8 sm:px-6 sm:py-10">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            GUGU Mint
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            连接钱包，输入/扫码获得的哈希，后端验证并在链上完成 Mint。
          </p>
        </header>

        <section className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col text-sm text-zinc-600 dark:text-zinc-400">
              <span className="text-xs uppercase tracking-wide text-zinc-500">
                钱包
              </span>
              <span className="truncate text-sm font-medium text-black dark:text-zinc-50 max-w-[11rem] sm:max-w-none">
                {account ? account : "未连接"}
              </span>
            </div>
            <button
              type="button"
              onClick={handleConnectButtonClick}
              disabled={wcConnecting}
              className="inline-flex h-11 items-center justify-center rounded-full bg-black px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-600 dark:bg-zinc-50 dark:text-black dark:hover:bg-zinc-200 sm:h-10 sm:px-5"
            >
              {wcConnecting
                ? account
                  ? "重新连接中..."
                  : "连接中..."
                : account
                ? "切换钱包 (WalletConnect)"
                : "连接钱包 (WalletConnect)"}
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            哈希
          </label>
          <div className="flex items-center gap-2">
            <input
              value={hash}
              onChange={(e) => setHash(e.target.value)}
              placeholder="请输入或粘贴后端分发的哈希"
              className="flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm text-black outline-none ring-0 transition focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
            />
            <button
              type="button"
              onClick={scanning ? stopScan : startScan}
              className="shrink-0 rounded-lg border border-zinc-300 px-3 py-2.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              {scanning ? "停止" : "扫码"}
            </button>
          </div>
          {scanError && (
            <span className="text-[11px] text-red-500 dark:text-red-400">
              {scanError}
            </span>
          )}
          {scanning && (
            <div className="mt-3 overflow-hidden rounded-2xl border border-zinc-300 bg-black/90 p-3 shadow-lg shadow-black/40 dark:border-zinc-700">
              <div
                id={qrCodeRegionId}
                className="h-64 w-full rounded-xl bg-black sm:h-72"
              />
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <button
            type="button"
            onClick={handleMint}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-full bg-emerald-600 px-6 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-400/70"
          >
            {loading ? "处理中..." : "验证并 Mint"}
          </button>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          )}

          {txHash && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
              <div className="font-medium">Mint 交易已提交</div>
              <div className="mt-1 break-all text-[11px]">{txHash}</div>
              {bscScanUrl && (
                <a
                  href={bscScanUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex text-[11px] font-medium text-emerald-700 underline dark:text-emerald-300"
                >
                  在 BscScan 查看
                </a>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
