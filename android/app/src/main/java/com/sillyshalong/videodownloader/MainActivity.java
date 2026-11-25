package com.sillyshalong.videodownloader;

import com.getcapacitor.BridgeActivity;

/**
 * 应用主界面（WebView 承载前端页面）。
 * 记录存活实例：系统文件夹选择器要从它所在的任务栈上弹出，选完才能直接回到界面。
 */
public class MainActivity extends BridgeActivity {
    static volatile MainActivity current;

    @Override
    protected void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = this;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (current == this) current = null;
    }
}
