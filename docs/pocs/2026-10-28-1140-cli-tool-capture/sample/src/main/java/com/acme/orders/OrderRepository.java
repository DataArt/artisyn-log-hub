package com.acme.orders;
import java.util.*;
public class OrderRepository {
  private final Map<String, Order> store = new HashMap<>();
  public Order findById(String id) { return store.get(id); }
  public void save(Order o) { store.put(o.getId(), o); }
}
