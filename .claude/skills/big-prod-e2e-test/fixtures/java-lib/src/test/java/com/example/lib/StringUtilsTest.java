package com.example.lib;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

class StringUtilsTest {

    @Test
    void capitalizesFirstLetter() {
        assertEquals("Hello", StringUtils.capitalize("hello"));
    }

    @Test
    void keepsEmptyAndNull() {
        assertEquals("", StringUtils.capitalize(""));
        assertNull(StringUtils.capitalize(null));
    }
}
