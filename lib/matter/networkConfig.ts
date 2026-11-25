/**
 * Matter 네트워크 설정 타입 + 사전 진단 (T039).
 *
 * SDK(@matter/*)를 import 하지 않는다. 실제 UDP 바인딩/mDNS 광고/인터페이스 선택은 SDK가 수행하며,
 * 이 파일은 (1) 설정 값을 SDK 변수/상태 이름으로 매핑하고 (2) SDK 기동 전에 사람이 읽을 수 있는 진단 메시지를 만든다.
 * 근거: docs/evidence/T039.md
 */
import {existsSync} from "node:fs";
import {type NetworkInterfaceInfo, networkInterfaces, platform} from "node:os";

export interface MatterNetworkConfig {
    /** 노드가 바인딩할 UDP 포트. 미지정이면 SDK 기본(5540, 이미 사용 중이면 SDK 판단). 복수 ServerNode는 노드마다 달라야 한다. */
    port?: number;
    /** mDNS(5353)를 이 인터페이스로 제한. 미지정이면 SDK가 모든 비-internal 인터페이스 사용. */
    mdnsInterface?: string;
    /** IPv4 사용(Matter는 IPv6 필수, IPv4는 선택). 기본 true(SDK 기본). */
    ipv4?: boolean;
    /** UDP 바인드 주소 고정(선택). */
    listeningAddressIpv4?: string;
    listeningAddressIpv6?: string;
}

export type NetworkDiagnosticLevel = "error" | "warn" | "info";

export interface NetworkDiagnostic {
    level: NetworkDiagnosticLevel;
    code: string;
    message: string;
}

export type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface NetworkCheckEnv {
    interfaces: () => InterfaceMap;
    platform: () => NodeJS.Platform;
    /** 컨테이너 휴리스틱 (/.dockerenv 존재). 확정이 아니므로 info/warn 수준으로만 사용. */
    inContainer: () => boolean;
}

const defaultEnv: NetworkCheckEnv = {
    interfaces: networkInterfaces,
    platform,
    inContainer: () => existsSync("/.dockerenv"),
};

/** SDK 환경 변수 이름(대소문자 무시, VariableService.set이 소문자화). `env.vars.set(name, value)`로 주입. */
export function toMatterEnvVars(config: MatterNetworkConfig): Record<string, string | boolean> {
    const vars: Record<string, string | boolean> = {};
    if (config.mdnsInterface) vars["mdns.networkInterface"] = config.mdnsInterface;
    // mdns.ipv4는 MdnsService가 읽는다. network.ipv4(ServerNode 상태)와 별개이므로 둘 다 맞춘다.
    if (config.ipv4 !== undefined) vars["mdns.ipv4"] = config.ipv4;
    return vars;
}

/** ServerNode `network` 상태 조각 (NetworkServer.State 필드 이름). 값이 없는 키는 포함하지 않는다. */
export function toServerNodeNetworkState(config: MatterNetworkConfig): {
    port?: number;
    ipv4?: boolean;
    listeningAddressIpv4?: string;
    listeningAddressIpv6?: string;
} {
    const state: ReturnType<typeof toServerNodeNetworkState> = {};
    if (config.port !== undefined) {
        assertMatterPort(config.port);
        state.port = config.port;
    }
    if (config.ipv4 !== undefined) state.ipv4 = config.ipv4;
    if (config.listeningAddressIpv4) state.listeningAddressIpv4 = config.listeningAddressIpv4;
    if (config.listeningAddressIpv6) state.listeningAddressIpv6 = config.listeningAddressIpv6;
    return state;
}

const VIRTUAL_NAME = /^(docker\d*|br-|veth|virbr|lo$|tun|tap|wg|tailscale|zt|vmnet|vEthernet)/i;
const VLAN_NAME = /\.\d+$|vlan/i;

function externalIpv6(infos: NetworkInterfaceInfo[] | undefined): NetworkInterfaceInfo[] {
    return (infos ?? []).filter((i) => i.family === "IPv6" && !i.internal);
}

/** SDK 기동 전 동기 진단. error가 하나라도 있으면 SDK 기동은 실패할 것이므로 호출자가 중단/보고한다. 성공을 위조하지 않는다. */
export function diagnoseMatterNetwork(config: MatterNetworkConfig, env: NetworkCheckEnv = defaultEnv): NetworkDiagnostic[] {
    const out: NetworkDiagnostic[] = [];
    const add = (level: NetworkDiagnosticLevel, code: string, message: string): void => {
        out.push({level, code, message});
    };

    if (config.port !== undefined && !isMatterPort(config.port)) {
        add("error", "PORT_INVALID", `Matter port ${config.port} is not an integer in 1..65535`);
    } else if (config.port !== undefined && config.port < 1024 && env.platform() !== "win32") {
        add("warn", "PORT_PRIVILEGED", `Matter port ${config.port} is < 1024; requires root/CAP_NET_BIND_SERVICE`);
    }

    const ifaces = env.interfaces();
    const names = Object.keys(ifaces);
    const candidates = names.filter((n) => ifaces[n]?.[0]?.internal === false);

    // Matter는 IPv6 UDP가 필수 (SDK: IPv6 없으면 NoAddressAvailableError로 기동 실패).
    const withIpv6 = candidates.filter((n) => externalIpv6(ifaces[n]).length > 0);
    if (withIpv6.length === 0) {
        add(
            "error",
            "IPV6_UNAVAILABLE",
            "No non-internal interface has an IPv6 address. Matter requires IPv6 (link-local fe80:: is sufficient). " +
                "Check the OS IPv6 setting (sysctl net.ipv6.conf.*.disable_ipv6=0), and in Docker use --network host.",
        );
    }

    if (config.mdnsInterface) {
        const infos = ifaces[config.mdnsInterface];
        if (!infos) {
            add("error", "IFACE_UNKNOWN", `mdns interface "${config.mdnsInterface}" not found. Available: ${candidates.join(", ") || "(none)"}`);
        } else if (externalIpv6(infos).length === 0) {
            add("error", "IFACE_NO_IPV6", `mdns interface "${config.mdnsInterface}" has no IPv6 address`);
        } else if (!externalIpv6(infos).some((i) => i.address.toLowerCase().startsWith("fe80"))) {
            add("warn", "IFACE_NO_LINKLOCAL", `mdns interface "${config.mdnsInterface}" has no fe80:: link-local address; discovery may fail`);
        }
        if (VIRTUAL_NAME.test(config.mdnsInterface)) {
            add(
                "warn",
                "IFACE_VIRTUAL",
                `"${config.mdnsInterface}" looks like a virtual/bridge interface; controllers on the LAN will not see mDNS from it`,
            );
        }
    } else if (withIpv6.length > 1) {
        const phys = withIpv6.filter((n) => !VIRTUAL_NAME.test(n));
        add(
            "warn",
            "MULTI_NIC",
            `Multiple IPv6-capable interfaces (${withIpv6.join(", ")}) and no mdnsInterface set. ` +
                "mDNS/UDP is served on all of them; if commissioning fails set mdnsInterface to the LAN-facing NIC" +
                (phys.length === 1 ? ` (likely "${phys[0]}")` : ""),
        );
    }

    const vlans = withIpv6.filter((n) => VLAN_NAME.test(n));
    if (vlans.length > 0 && !config.mdnsInterface) {
        add(
            "info",
            "VLAN",
            `VLAN-like interfaces (${vlans.join(", ")}): mDNS multicast (UDP 5353, ff02::fb / 224.0.0.251) does not cross VLANs; ` +
                "use an mDNS reflector or put controller and bridge on the same L2",
        );
    }

    if (config.ipv4 === false) {
        add("info", "IPV4_OFF", "IPv4 disabled; IPv4-only controllers/networks will not reach this node");
    }
    if (env.platform() === "win32") {
        add(
            "info",
            "WINDOWS",
            "Windows: IPv6 multicast interface is addressed by scope id (SDK handles this); " +
                "allow inbound UDP 5353 and the Matter port in Windows Firewall",
        );
    }
    if (env.platform() === "linux" && env.inContainer()) {
        add(
            "info",
            "CONTAINER",
            "Container detected (/.dockerenv): bridge networking does not forward mDNS multicast; " +
                "run with --network host (HAOS add-on: host_network: true)",
        );
    }
    return out;
}

function isMatterPort(value: number): value is number {
    return Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}

function assertMatterPort(value: number): asserts value is number {
    if (!isMatterPort(value)) throw new Error(`Matter port ${value} is not an integer in 1..65535`);
}

/** mDNS 5353 점유 참고: SDK는 reuseAddress로 5353을 공유 바인딩한다(avahi/mDNSResponder와 공존 가능). 별도 프로브 불필요. */
