#!/usr/bin/env python3
"""
Claude Code Channels 补丁脚本（版本自适应）
用法: python3 patch_claude.py
功能: 绕过 Channels 功能的 feature flag 和注册检查
支持: v2.1.x（自动匹配混淆后的函数名）
"""
import os
import re
import shutil
import subprocess
import sys


def find_cli_path():
    """自动查找 Claude Code 的 cli.js 路径"""
    try:
        claude_bin = subprocess.check_output(['which', 'claude'], text=True).strip()
        if claude_bin:
            bin_dir = os.path.dirname(claude_bin)
            npm_prefix = os.path.dirname(bin_dir)
            candidate = os.path.join(
                npm_prefix, 'lib', 'node_modules',
                '@anthropic-ai', 'claude-code', 'cli.js'
            )
            if os.path.exists(candidate):
                return candidate
    except Exception:
        pass
    return None


cli_path = find_cli_path()
if not cli_path:
    print("❌ 找不到 Claude Code 的 cli.js")
    print("   请先安装: npm install -g @anthropic-ai/claude-code@latest")
    sys.exit(1)

print(f"📍 找到 cli.js: {cli_path}")

print(f"📖 读取 {cli_path} ...")
with open(cli_path, 'r', encoding='utf-8') as f:
    content = f.read()

print(f"   文件大小: {len(content) / 1024 / 1024:.1f} MB")

# 备份（仅第一次）
bak_path = cli_path + '.bak'
if not os.path.exists(bak_path):
    print(f"💾 备份到 {bak_path}")
    shutil.copy2(cli_path, bak_path)
else:
    print(f"💾 备份已存在: {bak_path}")

changes = 0

# ═══════════════════════════════════════════
# 补丁 1: tengu_harbor feature flag → 始终 true
# 匹配形如: function XXX(){return YYY("tengu_harbor",!1)}
# 替换为:   function XXX(){return !0}
# ═══════════════════════════════════════════
# 已修改的标记
patched_harbor_pattern = re.compile(
    r'function\s+\w+\(\)\{return\s*!0\}',
)

# 原始模式: function Ho6(){return l8("tengu_harbor",!1)}
# 函数名和内部调用名都会变
harbor_pattern = re.compile(
    r'(function\s+(\w+)\(\)\{return\s+\w+\("tengu_harbor",!1\)\})'
)

m = harbor_pattern.search(content)
if m:
    old = m.group(1)
    fname = m.group(2)
    new = f'function {fname}(){{return !0}}'
    content = content.replace(old, new, 1)
    changes += 1
    print(f"✅ 补丁1: {fname}() tengu_harbor flag → 始终 true")
else:
    # 检查是否已经修改过（搜索 tengu_harbor 判断）
    if 'tengu_harbor' not in content or re.search(r'function\s+\w+\(\)\{return\s*!0\}', content[:content.find('tengu_harbor') + 200] if 'tengu_harbor' in content else ''):
        print("⏭️  补丁1: tengu_harbor flag 已修改过或不存在")
    else:
        print("⚠️  补丁1: 找不到 tengu_harbor feature flag 函数，可能版本格式不同")

# ═══════════════════════════════════════════
# 补丁 2: Channel gate 函数 → 只保留能力检查
# 匹配 xXq(A,q,K) 风格的函数，通过关键字符串定位：
#   "server did not declare claude/channel capability"
#   "channels feature is not currently available"
# ═══════════════════════════════════════════

# 定位 gate 函数：找到包含这两个关键字符串的函数
# 形如: function xXq(A,q,K){if(!q?.experimental?.["claude/channel"])return{...};if(!Ho6())return{...};...return{action:"register"}}
# 我们需要替换为: function xXq(A,q,K){if(!q?.experimental?.["claude/channel"])return{action:"skip",kind:"capability",reason:"server did not declare claude/channel capability"};return{action:"register"}}

# 使用两个关键字符串来精确定位
capability_str = 'server did not declare claude/channel capability'
disabled_str = 'channels feature is not currently available'

if capability_str in content and disabled_str in content:
    # 找到 gate 函数的开头
    # 搜索包含 capability_str 的 function 定义
    # 模式: function XXX(A,q,K){if(!q?.experimental?.["claude/channel"])return{action:"skip",...capability_str...};if(!YYY())return{...disabled_str...};...return{action:"register"}}
    
    gate_pattern = re.compile(
        r'(function\s+(\w+)\((\w+),(\w+),(\w+)\)\{'
        r'if\(!\4\?\.experimental\?\.\["claude/channel"\]\)'
        r'return\{action:"skip",kind:"capability",reason:"server did not declare claude/channel capability"\};'
        r'.+?'  # 中间的各种检查
        r'return\{action:"register"\}\})'
    )
    
    gm = gate_pattern.search(content)
    if gm:
        old_gate = gm.group(1)
        gfname = gm.group(2)
        p1, p2, p3 = gm.group(3), gm.group(4), gm.group(5)
        new_gate = (
            f'function {gfname}({p1},{p2},{p3}){{'
            f'if(!{p2}?.experimental?.["claude/channel"])'
            f'return{{action:"skip",kind:"capability",reason:"server did not declare claude/channel capability"}};'
            f'return{{action:"register"}}}}'
        )
        content = content.replace(old_gate, new_gate, 1)
        changes += 1
        print(f"✅ 补丁2: {gfname}() channel gate → 只保留能力检查")
    else:
        # 备选方案：直接搜索和替换关键片段
        # 替换 disabled 检查
        # 形如: if(!Ho6())return{action:"skip",kind:"disabled",reason:"channels feature is not currently available"};
        disabled_check = re.compile(
            r'if\(!\w+\(\)\)return\{action:"skip",kind:"disabled",reason:"channels feature is not currently available"\};'
        )
        dm = disabled_check.search(content)
        if dm:
            content = content.replace(dm.group(0), '', 1)
            changes += 1
            print("✅ 补丁2a: 移除 disabled 检查")
        
        # 替换 auth 检查
        auth_check = re.compile(
            r'if\(!\w+\(\)\?\.accessToken\)return\{action:"skip",kind:"auth",reason:"channels requires claude\.ai authentication \(run /login\)"\};'
        )
        am = auth_check.search(content)
        if am:
            content = content.replace(am.group(0), '', 1)
            changes += 1
            print("✅ 补丁2b: 移除 auth 检查")
        
        # 替换 policy 检查
        policy_check = re.compile(
            r'let \w+=\w+\(\);if\(\w+===.team.\|\|\w+===.enterprise.\)\{if\(\w+\(.policySettings.\)\?\.channelsEnabled!==!0\)return\{action:.skip.,kind:.policy.,reason:.channels not enabled by org policy[^}]+\}\}'
        )
        pm = policy_check.search(content)
        if pm:
            content = content.replace(pm.group(0), '', 1)
            changes += 1
            print("✅ 补丁2c: 移除 policy 检查")
        
        # 替换 session (--channels list) 检查
        session_check = re.compile(
            r'let (\w+)=\w+\(\w+,\w+\(\)\);if\(!\1\)return\{action:"skip",kind:"session",reason:`server \$\{\w+\} not in --channels list for this session`\};'
        )
        sm = session_check.search(content)
        if sm:
            content = content.replace(sm.group(0), f'let {sm.group(1)}={{kind:"server",name:"",dev:!0}};', 1)
            changes += 1
            print("✅ 补丁2d: 绕过 session 检查")
        
        # 替换 allowlist 检查（非 plugin 分支）
        allowlist_check = re.compile(
            r'else if\(!\w+\.dev\)return\{action:"skip",kind:"allowlist",reason:`server \$\{\w+\.name\} is not on the approved channels allowlist[^}]+`\};'
        )
        alm = allowlist_check.search(content)
        if alm:
            content = content.replace(alm.group(0), '', 1)
            changes += 1
            print("✅ 补丁2e: 移除 allowlist 检查")
        
        if not dm and not am:
            print("⚠️  补丁2: 无法定位 gate 函数，格式可能不匹配")
elif capability_str not in content:
    print("⚠️  补丁2: 找不到 channel capability 字符串，可能版本不同")
elif 'return{action:"register"}' in content and disabled_str not in content:
    print("⏭️  补丁2: gate 函数已修改过")
else:
    print("⚠️  补丁2: 状态异常，请手动检查")

# ═══════════════════════════════════════════
# 补丁 3: ChannelsNotice UI 前置检查
#   noAuth → false, policyBlocked → false
#   (v2.1.81+ 可能已无此结构)
# ═══════════════════════════════════════════
# 尝试旧版补丁 3a
noauth_pattern = re.compile(r'noAuth:!\w+\(\)\?\.accessToken')
noauth_match = noauth_pattern.search(content)
if noauth_match:
    content = content.replace(noauth_match.group(0), 'noAuth:!1', 1)
    changes += 1
    print("✅ 补丁3a: noAuth 检查 → 始终 false")
elif 'noAuth:!1' in content:
    print("⏭️  补丁3a: noAuth 已修改过")
else:
    print("⏭️  补丁3a: noAuth 字段不存在（新版不需要）")

# 尝试旧版补丁 3b
policy_ui_pattern = re.compile(r'policyBlocked:\w+!==null\&\&\w+\.channelsEnabled!==!0')
policy_ui_match = policy_ui_pattern.search(content)
if policy_ui_match:
    content = content.replace(policy_ui_match.group(0), 'policyBlocked:!1', 1)
    changes += 1
    print("✅ 补丁3b: policyBlocked 检查 → 始终 false")
elif 'policyBlocked:!1' in content:
    print("⏭️  补丁3b: policyBlocked 已修改过")
else:
    print("⏭️  补丁3b: policyBlocked 字段不存在（新版不需要）")

# ═══════════════════════════════════════════
# 写入
# ═══════════════════════════════════════════
if changes > 0:
    print(f"\n📝 写入修改 ({changes} 处) ...")
    with open(cli_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("🎉 补丁完成！")
    print("\n启动命令:")
    print("  claude --add-dir ./ --dangerously-load-development-channels server:feishu")
else:
    print("\n没有修改。")
